# Spec 04 — Running means mid-turn, not merely open

**Status:** implemented · **Depends on:** [01](01-surface-visibility.md), [03](03-subagents.md)

Two bugs about the same thing: reading a thread's *state* off signals that were only proxies
for it.

## Bug A — a live process is not work in progress

### Symptom

A session finished, reported `51 tests pass, ruff clean` and asked whether to commit. Its
astronaut kept hammering, and so did the six yellow workers it had spawned. Nothing on the map
said the thread was waiting for a reply.

### Cause

```js
thread.running = thread.hasLiveProcess && now - thread.lastActivityAt < ACTIVE_WINDOW_MS
```

The CLI holds its process open while it sits at its prompt. "The pid exists and the transcript
moved in the last 30 minutes" is true of a thread that answered you four minutes ago and is now
idle at the prompt — an astronaut hammering away at a thread whose whole point is that it is
waiting.

Terminal-only threads made it worse: `unread` is derived from the desktop app's focus history,
which they do not have, so such a thread could not ask for anything at all.

### Fix

The transcript says whose turn it is. Read its tail for any thread that could plausibly be
running.

`server/lib/fsutil.mjs` — the mirror of `readHead`, dropping the leading partial line:

```js
export async function readTail(file, bytes) { /* read the last `bytes`, slice past the first \n */ }
```

`server/harnesses/claude-code.mjs`:

```js
const TAIL_BYTES = 64 * 1024

async function awaitingReply(file) {
  const records = jsonLines(await readTail(file, TAIL_BYTES))
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.type === 'user') return false          // the model speaks next
    if (r.type !== 'assistant') continue         // attachments, refs, summaries
    const content = r.message?.content
    const calling = Array.isArray(content) && content.some((c) => c?.type === 'tool_use')
    return !calling && r.message?.stop_reason !== 'tool_use'
  }
  return false
}
```

In the finalisation loop:

```js
const fresh = now - thread.lastActivityAt < ACTIVE_WINDOW_MS
const waiting = thread.hasLiveProcess && fresh && thread.transcriptFile
  ? await awaitingReply(thread.transcriptFile) : false
thread.running = thread.hasLiveProcess && fresh && !waiting
if (waiting && !thread.subagent) thread.unread = true
```

Carry `transcriptFile` on the private thread shape at all three construction sites (desktop,
CLI, subagent) and strip it in `toThread`.

### Do not use `stop_reason` alone

It is `end_turn` on a main thread's last message and **empty** on a subagent's. The first
attempt tested `stop_reason === 'end_turn'` and left every finished worker hammering. What the
message *called* is the reliable half; the `stop_reason` check only guards the mid-tool-call
case.

### Why a worker never becomes `unread`

Nobody replies to a worker — it simply stops. Setting `unread` on one would put a `?` over an
astronaut with nothing to answer. The status rule in [03](03-subagents.md) enforces this a
second time, in `statusFor`, so no adapter can hand the colony a worker that begs.

## Bug B — the desktop timestamp lags, and fixing that broke `unread`

### Symptom, part one

An actively running session read as **102 minutes** old and never appeared on the surface.

### Cause

`lastActivityAt` came from the desktop record, which the app writes when a thread is *focused*.
A session running in a terminal, or in a window you are not looking at, reads as hours old while
its transcript is being written to this second.

### Fix

```js
lastActivityAt: Math.max(
  num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
  entry?.mtime || 0
),
```

### Symptom, part two — the regression that caused

Immediately after, stale finished threads reappeared as `?` astronauts: 190 threads flagged
unread, 15 on the surface where 2 belonged. They looked like sessions already dealt with,
coming back.

### Cause

```js
thread.unread = thread.desktopSessionIds.length > 0 && thread.lastActivityAt > thread.lastFocusedAt
```

Once `lastActivityAt` included the transcript's mtime, that compared a **file's mtime** against
**when you last looked**. An mtime moves for reasons that have nothing to do with you — a
resumed CLI session, a background write — so old threads flipped to unread, and unread outlives
the idle window by design.

### Fix

Keep the record's own number as a private `recordActivityAt`, and compare *that*:

```js
recordActivityAt: num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
// ...
const seenAt = thread.recordActivityAt ?? thread.lastActivityAt
thread.unread = thread.desktopSessionIds.length > 0 && seenAt > thread.lastFocusedAt
```

`lastActivityAt` decides freshness and sort order; unread stays a comparison between the app's
own two numbers. Strip `recordActivityAt` in `toThread`.

## Verification

Live scan, before → after bug A:

| Thread | Before | After |
| --- | --- | --- |
| Sentry issues (finished, asked a question) | working | **needs you** |
| its 2 workers | working | idle → off the surface |
| sentry-triage skill | working | **needs you** |
| its 3 workers | working | idle → off the surface |
| the session doing this work | idle, "102m ago" | **working**, 0m |

Bug B, before → after: threads flagged unread 190 → 135; on the surface 15 → 2.

Reproducing by hand: the tail of a finished session's transcript ends with an assistant message
whose content is `["text"]` and `stop_reason: "end_turn"`; a busy one ends with
`["tool_use"]` / `stop_reason: "tool_use"`; a finished **subagent** ends with `["text"]` and no
`stop_reason` at all. Those three shapes are the whole test.

## Edge cases

- **Cost.** `awaitingReply` runs only for threads that are live *and* fresh — a handful per
  poll. A machine with fifty live sessions pays fifty 64 KB reads per poll.
- **Long tool calls.** A thread mid-`bash` writes nothing for minutes, but its last record is
  still a `tool_use`, so it stays `working`. This is why the check is structural rather than a
  tighter time window: a 4-minute silence window would flap.
- **In-session write gaps**, measured on real transcripts: median 0–1 s, p90 4–9 s, p99
  55–203 s. Any time-only heuristic has to sit above that and still below a human's reply time,
  which is not a gap that reliably exists.
