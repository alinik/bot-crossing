/**
 * Just enough LevelDB to read one key out of the Claude desktop app's local storage.
 *
 * Everything else this app reads is a plain file. Session *groups* — the folders you drag
 * threads into in the desktop sidebar — are the exception: they never reach the session
 * records on disk, and live only in the app's web local storage, which Chromium keeps in a
 * LevelDB. There is no smaller door. So this is a read-only reader for the two file formats
 * that store actually hold — the write-ahead log and the sorted table — plus the Snappy
 * decoder they are compressed with, and nothing else: no iterators, no manifest, no writes.
 *
 * It never opens the database. It reads the files as bytes, in a directory another process
 * owns and is still writing to, so *everything* here is best-effort: a torn record, a
 * compression type this does not know, a format Chromium changes tomorrow — each one drops
 * the entry it came from and the caller sees a colony with no groups in it, which is the
 * same picture as a user who has never made one.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Recognises a sorted table. The last eight bytes of every `.ldb` file. */
const SST_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb])
const FOOTER_BYTES = 48
/** The log is written in fixed blocks; a record never straddles one without saying so. */
const LOG_BLOCK = 32 * 1024
const LOG_HEADER = 7

/** Read a varint at `pos`. Returns the value and where it ended. */
function varint(buf, pos) {
  let value = 0
  let shift = 0
  while (pos < buf.length) {
    const byte = buf[pos++]
    value += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return { value, pos }
    shift += 7
    if (shift > 56) break
  }
  throw new Error('truncated varint')
}

/**
 * Snappy, raw format — the block compression LevelDB uses. Literals are copied out and
 * back-references are expanded a byte at a time, because a reference is allowed to overlap
 * the region it is still writing (that is how Snappy encodes a repeat).
 */
function unsnappy(input) {
  const header = varint(input, 0)
  const out = Buffer.allocUnsafe(header.value)
  let pos = header.pos
  let out_i = 0
  const back = (offset, length) => {
    if (offset <= 0 || offset > out_i) throw new Error('bad copy offset')
    for (let i = 0; i < length; i++, out_i++) out[out_i] = out[out_i - offset]
  }
  while (pos < input.length) {
    const tag = input[pos]
    switch (tag & 3) {
      case 0: {
        // Literal. Lengths past 60 are spelled out in the following one to four bytes.
        let length = tag >> 2
        pos += 1
        if (length >= 60) {
          const bytes = length - 59
          length = 0
          for (let i = 0; i < bytes; i++) length += input[pos + i] * 2 ** (8 * i)
          pos += bytes
        }
        length += 1
        input.copy(out, out_i, pos, pos + length)
        out_i += length
        pos += length
        break
      }
      case 1: {
        back(((tag >> 5) << 8) | input[pos + 1], 4 + ((tag >> 2) & 7))
        pos += 2
        break
      }
      default: {
        const bytes = (tag & 3) === 2 ? 2 : 4
        let offset = 0
        for (let i = 0; i < bytes; i++) offset += input[pos + 1 + i] * 2 ** (8 * i)
        back(offset, (tag >> 2) + 1)
        pos += 1 + bytes
      }
    }
  }
  if (out_i !== out.length) throw new Error('short snappy stream')
  return out
}

/** Unwrap one stored block: payload, a compression byte, then a checksum that is not verified. */
function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size)
  const kind = file[offset + size]
  if (kind === 0) return raw
  if (kind === 1) return unsnappy(raw)
  // 2 and 4 are zlib and zstd. Chromium does not use them here; if that changes, the caller
  // loses this block rather than the whole read.
  throw new Error(`unsupported block compression ${kind}`)
}

/**
 * Walk a block's entries. Keys are stored as a delta against the one before — a shared
 * prefix length and the rest — so they only make sense in order, from the start.
 */
function* blockEntries(block) {
  const restarts = block.readUInt32LE(block.length - 4)
  const end = block.length - 4 - restarts * 4
  let pos = 0
  let previous = Buffer.alloc(0)
  while (pos < end) {
    const a = varint(block, pos)
    const b = varint(block, a.pos)
    const c = varint(block, b.pos)
    pos = c.pos
    const key = Buffer.concat([previous.subarray(0, a.value), block.subarray(pos, pos + b.value)])
    pos += b.value
    const value = block.subarray(pos, pos + c.value)
    pos += c.value
    previous = key
    yield { key, value }
  }
}

/**
 * Every live entry in one sorted table, newest-wins left to the caller.
 *
 * The footer names the index block, the index block names every data block, and each data
 * block holds the entries. An internal key carries an eight-byte trailer — the sequence
 * number and whether the entry is a put or a delete — which is exactly what decides who wins
 * when the same key is in three files at once.
 */
function* tableEntries(file) {
  if (file.length < FOOTER_BYTES || !file.subarray(file.length - 8).equals(SST_MAGIC)) return
  const footer = file.length - FOOTER_BYTES
  const metaOffset = varint(file, footer)
  const metaSize = varint(file, metaOffset.pos)
  const indexOffset = varint(file, metaSize.pos)
  const indexSize = varint(file, indexOffset.pos)
  const index = readBlock(file, indexOffset.value, indexSize.value)
  for (const entry of blockEntries(index)) {
    let block
    try {
      const offset = varint(entry.value, 0)
      const size = varint(entry.value, offset.pos)
      block = readBlock(file, offset.value, size.value)
    } catch {
      continue // One unreadable block, not one unreadable database.
    }
    try {
      for (const row of blockEntries(block)) {
        if (row.key.length < 8) continue
        // The trailer is one little-endian number: the entry type in the low byte, the
        // sequence in the seven above it.
        const trailer = row.key.subarray(row.key.length - 8)
        yield {
          key: row.key.subarray(0, row.key.length - 8),
          value: row.value,
          seq: trailer.readUIntLE(1, 6) + trailer[7] * 2 ** 48,
          deleted: trailer[0] === 0,
        }
      }
    } catch {
      continue
    }
  }
}

/** Read a length-prefixed string at `pos`, the way a write batch stores one. */
function varstring(buf, pos) {
  const length = varint(buf, pos)
  return { value: buf.subarray(length.pos, length.pos + length.value), pos: length.pos + length.value }
}

/**
 * Every entry in the write-ahead log — the writes that have not been folded into a table yet,
 * which is where anything changed in the last few minutes still lives.
 *
 * Records are framed inside fixed blocks and a long one is split across them, so the
 * fragments are stitched back together before the batch inside is read. The tail of a log
 * being written to right now is routinely half a record; that ends the walk rather than
 * failing it.
 */
function* logEntries(file) {
  let pos = 0
  let pending = []
  while (pos + LOG_HEADER <= file.length) {
    const length = file.readUInt16LE(pos + 4)
    const kind = file[pos + 6]
    const start = pos + LOG_HEADER
    if (kind === 0 || start + length > file.length) break // Padding to the block edge, or a torn tail.
    const payload = file.subarray(start, start + length)
    pos = start + length
    // Skip the header that would straddle the next block boundary.
    if (LOG_BLOCK - (pos % LOG_BLOCK) < LOG_HEADER) pos += LOG_BLOCK - (pos % LOG_BLOCK)

    if (kind === 1) pending = [payload]
    else pending.push(payload)
    if (kind !== 1 && kind !== 4) continue // FULL and LAST end a record; FIRST and MIDDLE do not.

    const batch = Buffer.concat(pending)
    pending = []
    if (batch.length < 12) continue
    let seq = batch.readUIntLE(0, 6)
    const count = batch.readUInt32LE(8)
    let at = 12
    try {
      for (let i = 0; i < count; i++, seq++) {
        const tag = batch[at++]
        const key = varstring(batch, at)
        at = key.pos
        if (tag === 0) {
          yield { key: key.value, value: Buffer.alloc(0), seq, deleted: true }
          continue
        }
        const value = varstring(batch, at)
        at = value.pos
        yield { key: key.value, value: value.value, seq, deleted: false }
      }
    } catch {
      continue
    }
  }
}

/**
 * The current value of one local-storage key, or `null`.
 *
 * Chromium keys local storage as `_<origin>\0\1<key>`, and prefixes the value with a byte
 * saying how the text is encoded: `1` for one byte per character, `0` for UTF-16. The same
 * key can appear in several files at once — a log record, an old table, a compacted one — so
 * the highest sequence number wins, and a delete at the top wins as an absence.
 */
export async function readLocalStorage(dir, origin, key) {
  const wanted = Buffer.concat([Buffer.from(`_${origin}`, 'utf8'), Buffer.from([0, 1]), Buffer.from(key, 'utf8')])
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return null
  }
  let best = null
  for (const name of names) {
    const table = name.endsWith('.ldb')
    if (!table && !name.endsWith('.log')) continue
    let file
    try {
      file = await fsp.readFile(path.join(dir, name))
    } catch {
      continue
    }
    try {
      for (const entry of table ? tableEntries(file) : logEntries(file)) {
        if (!entry.key.equals(wanted)) continue
        if (!best || entry.seq >= best.seq) best = entry
      }
    } catch {
      continue
    }
  }
  if (!best || best.deleted) return null
  const body = best.value.subarray(1)
  return best.value[0] === 0 ? body.toString('utf16le') : body.toString('utf8')
}
