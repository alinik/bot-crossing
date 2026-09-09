# 09 — A sidebar group is a zone

## Problem

Zones are repos, and a repo is a guess. It says where a thread runs, not what it is for: the
three threads standing up an org — CI on `backend`, a scratch checkout, a settings pass in a
third folder — land on three hexes at opposite ends of the colony, and the one piece of work
they are all part of has no place on the map at all.

The desktop app already knows. Its Claude Code sidebar lets you drag threads into a named
group, and that is the only field on a thread anybody deliberately set: a title is generated,
a repo is wherever the terminal happened to be, a group is you saying *these belong together*.
Nothing in the colony read it.

## Where a group actually lives

Not in the session record. `claude-code-sessions/<account>/<org>/<sessionId>.json` has 60-odd
keys across 356 records here and not one of them names a group. The sidebar is a web view, and
it keeps its own state in the app's local storage — a Chromium LevelDB at
`Local Storage/leveldb` under the desktop app's data directory, origin `https://claude.ai`,
key `LSS-persisted.dframe-group-scopes`:

```json
{"value":{"<account>/<org>":{
  "groups":[{"id":"cg-4876b77b-…","name":"Mehrito"}],
  "assignments":{"code:local_7bfbc5b5-…":"cg-4876b77b-…"},
  "order":{"cg-4876b77b-…":["code:local_7bfbc5b5-…", "…"]}}}}
```

The assignment key is `code:` plus the **desktop** session id — exactly the id the adapter
already carries in `ref.desktopSessionIds`, so the join needs nothing new on the thread.

## Decision — read the LevelDB, in about 200 lines, or draw no groups

Everything else this app reads is a plain file, and that is worth keeping. Two ways to break
it: take an npm dependency with a native build (`classic-level`) for one key, or read the two
file formats a LevelDB actually stores. The store here is ~230 KB and only ever read, so the
second is smaller than it sounds and adds nothing to `package.json`.

`server/harnesses/leveldb.mjs` is that reader: a raw Snappy decoder, the sorted-table format
(footer → index block → data blocks, prefix-compressed entries), the write-ahead log (block
framing, then a write batch), and one exported function.

```js
readLocalStorage(dir, origin, key) // → string | null
```

It never opens the database and never writes. The app is running and appending to the log
while this reads it, so every layer swallows its own failures — a torn record, a compression
type it does not know, a format Chromium changes — and the worst outcome is `null`, which is
a colony with no groups in it: the same picture as a user who never made one.

### The trailer bit that costs an hour

A LevelDB internal key ends in eight little-endian bytes holding *both* the sequence number
and the entry type. The type is the **low** byte and the sequence the seven above it:

```js
seq: trailer.readUIntLE(1, 6) + trailer[7] * 2 ** 48,
deleted: trailer[0] === 0,
```

Read it the other way round and every live entry looks deleted — the key is found, matches
byte for byte, and the reader still returns `null`.

## Implementation

**Adapter** (`server/harnesses/claude-code.mjs`). `scanSessionGroups()` returns a map of
desktop session id → `{ id, name }`, folding every account and organisation together: a
session id is unique across them, and the colony draws whatever is on the machine. The store
is parsed once per change, keyed on the newest mtime across the directory — a poll every few
seconds must not re-parse a database that has not moved.

Two fields land on the thread: `group` (the name, for the plaque) and `groupId` (the key,
because a group can be renamed and its id cannot). A resumed conversation has more than one
desktop record and only one of them carries the assignment, so every id in
`desktopSessionIds` is tried. A subagent inherits its parent's group in the same pass that
gives it its parent's project — a worker is part of whatever its parent is part of.

**Zoning** (`src/game/task-types.js`). `zonesFor` scopes by `group:<groupId>` when a thread
has one and by project otherwise, so grouped threads leave their repos and stand together:

```js
const key = thread.groupId ? `group:${thread.groupId}` : thread.project || 'unknown'
```

A group named after a repo absorbs it. Naming a group after the thing it is about is the
obvious thing to do, and it was the first thing that happened here: a group `Mehrito` beside a
repo folder `Mehrito` produced two hexes with the same plaque — the three grouped threads on
one, a single ungrouped thread from that folder on the other — which reads as a duplicate
rather than as a distinction. So a thread whose project name matches a group's name takes that
group's zone, dragged there or not:

```js
const groupId = thread.groupId || groupNamed.get(project) || ''
```

The match is on the exact project name, so a neighbouring `hosts-mehrito-ir-2ecbab` keeps its
own hex. Two groups sharing a name is the user's business; the first one seen takes the repo.

The zone's `label` is the group name — read off the first thread in the zone that *has* a
group, since an absorbed repo puts ungrouped threads in there too. Its `project` is still a real repo — the commonest
among its threads — because `plot.project` is what the Ignore button ignores and what the
new-thread toast names, and neither means anything said of a group. A group past `splitAt`
splits by task type exactly like a repo, keys `group:<id>›reviews`.

## Verified

- Real store: 597 threads scanned, 3 grouped into `Mehrito`, spanning two different repos.
- Group `Mehrito` beside repo `Mehrito`: one hex, four threads — three grouped and the repo's
  one ungrouped thread absorbed. `hosts-mehrito-ir-2ecbab` stays a hex of its own.
- `zonesFor` with those threads: one `group:cg-1` zone labelled `Mehrito`, `project` the repo
  two of the three came from; ungrouped threads still zone by project.
- At `splitAt: 1` the group splits into `group:cg-1›reviews` and `group:cg-1›fixes`.
- `npm run build` clean.

## Edge cases

- **Nothing grouped, or the store unreadable.** Every thread zones by project, as before.
- **A group renamed.** The zone keeps its key and its position; only the plaque changes.
- **A group named after a repo.** The repo folds into it, ungrouped threads included — see
  above. A group named after nothing on disk changes no other zone.
- **A group whose threads span repos.** Expected — it is the reason the feature exists. The
  hex's folder actions follow the commonest directory, which `pathForProject` already picks
  from the threads standing on the zone rather than from the zone name.
- **Grouped entries that are not threads.** The sidebar groups other kinds of entry too; only
  keys prefixed `code:` are threads, and the rest are dropped.
