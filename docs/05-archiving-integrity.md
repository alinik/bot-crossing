# Spec 05 — Archiving integrity

**Status:** implemented · **Depends on:** [03](03-subagents.md)

Four bugs in one area: an archive that did not stick, an archive that did not follow a thread
through a re-key, an archive button that could not be pressed, and an archive that left half its
work behind.

## Background

Two records exist for an archive, and both matter:

- **The harness's own flag** — `isArchived` in the desktop app's session record. Best-effort:
  the app rewrites its records whenever it touches a thread, which silently clears a flag set
  from outside, so the colony re-asserts it on every scan.
- **The colony's own list** — `state.archived` in `data/colony.json`, written only by the page.
  This is the authority.

## Bug A — archived threads returning as nameless twins

### Symptom

Threads archived days ago reappeared on the map as `Untitled thread` astronauts. Opening one
made it vanish, which made it look like the archive had never been recorded.

### Cause

Resuming a thread makes the desktop app write a **second** record for the same conversation.
One carries the title and the transcript link; the other carries nothing. When the empty one has
no `cliSessionId` there is no key to merge the pair on, so it survives as a thread of its own.
Archiving the real thread wrote `isArchived` to the ids in *its* `ref` and never touched the
twin.

(The second half of the symptom was unrelated and correct: opening a thread sets
`lastFocusedAt`, so it stops being unread and falls outside the idle window — see
[01](01-surface-visibility.md).)

### Fix

In `scanThreads`, before the finalisation loop, drop the app's empty bookkeeping records:

```js
const NEW_SESSION_MS = 10 * 60 * 1000
const threads = [...byId.values()].filter(
  (t) => t.hasTranscript || t.titled || t.hasLiveProcess ||
         now - (t.lastActivityAt || t.createdAt || 0) < NEW_SESSION_MS
)
```

A record with no transcript, no title and no live process is not a conversation. The age check
keeps a genuinely new session — opened seconds ago, nothing written yet — from being swept up.

Removed 16 phantom threads on a real machine; all were 8+ days old, none live.

## Bug B — an archive lost when a thread is re-keyed

### Cause

The colony remembers an archive by the thread id the page saw, but that is only the *canonical*
id: a thread keyed by a desktop record today can be keyed by its transcript tomorrow, once the
CLI writes one.

### Fix

In `reconcileArchived`, match on the ids inside `ref` as well:

```js
const isArchived = (thread) => {
  if (thread.subagent) return wanted.has(thread.id)   // a worker's ref is empty by design
  if (wanted.has(thread.id)) return true
  const ref = thread.ref || {}
  if (ref.cliSessionId && wanted.has(ref.cliSessionId)) return true
  return (ref.desktopSessionIds || []).some((id) => wanted.has(id))
}
```

`archivedAt` becomes the newest timestamp across all those ids, which keeps `archivePending`
(whether the app has read the flag yet) honest.

## Bug C — every terminal-only thread unarchivable

### Symptom

The Archive button was dead on whole hexagons — `pr-reviewer` among them.

### Cause

A regression introduced while disabling Archive for subagents. The button was newly disabled on
`canArchive`, and that flag meant *"the desktop app has a record to flag"*:

```js
canArchive: desktopSessionIds.length > 0   // false for every terminal-only thread
```

Before the button respected the flag, clicking it archived colony-only and worked. 72 of 387
threads were affected.

### Fix

Any real thread can be retired; the harness write is best-effort on top of the colony's list.

```js
canArchive: !t.subagent,
```

And in `/api/archive`, take the colony-only path explicitly when there is nothing to write to,
rather than falling through to a write that fails:

```js
const records = ref?.desktopSessionIds?.length || 0
if (!ref || !harness || !records) {
  return send(res, 200, { ok: true, archived: Boolean(archived), harnessRecord: false,
    note: 'Archived in the colony. That harness has no session record for this thread.' })
}
```

The page already reports this correctly: `harnessRecord === false` produces
"Archived here (no *harness* record for it)".

## Bug D — an archived parent leaves its workers behind

### Symptom

A zone (`withdraw-bc`) held nine astronauts, every one of them a subagent, none archivable —
all their parents had already been archived. Nothing on that zone could be acted on or led
anywhere.

### Cause

A worker's own archive flag can never be set: it has no record to write and no button to press
([03](03-subagents.md)). So archiving a thread retired the thread and orphaned its fan-out.

### Fix

A second pass at the end of `reconcileArchived`:

```js
const gone = new Set(reconciled.filter((t) => t.archived).map((t) => t.id))
return reconciled.map((t) =>
  t.subagent && !t.archived && gone.has(t.parentId) ? { ...t, archived: true } : t
)
```

Archiving the parent is the one gesture that retires its workers, which is exactly what it
should mean.

## Bug E — an archive could not be undone

### Symptom

A live session vanished from the map and there was no way to bring it back. Archiving wrote to
the colony's list *and* to the harness's own record, and nothing anywhere could reverse either
— an `A` pressed with an astronaut selected retired a running thread permanently, short of
hand-editing `data/colony.json`.

### Fix, part one: a way back

`main.js` gains `actions.restoreThread(id)`: drop the id from `state.archived` and
`state.archivedAt`, save, then `archiveThread(thread, false)` to clear the harness's own flag —
best-effort, exactly as archiving is. The HUD lists what you archived, newest first, under
**Who shows up**, capped at 12 rows with a count of the rest; each row is a click away from
coming back.

Twelve rather than all of them: with a few hundred archived threads a full list is a scroll
nobody reads, and the one you want back is almost always the one you just put away.

### Fix, part two: activity un-archives

Archiving says *I am done with this*. Going back to the session says the opposite, and it is
the more recent of the two — so the colony should not keep arguing with a thread you are
visibly using.

In `reconcileArchived`, a thread whose activity is later than its own `archivedAt` is no longer
archived:

```js
const REVIVE_GRACE_MS = 5000

if (at && thread.lastActivityAt > at + REVIVE_GRACE_MS) {
  if (thread.archived && thread.canArchive) {
    await setThreadArchived(thread.harness, thread.ref, false).catch(() => {})
  }
  return { ...thread, archived: false, unarchivedByActivity: true }
}
```

The grace matters: archiving a live thread makes the harness rewrite its own records, and
without a few seconds of slack that write reads as activity and undoes the archive on the next
poll.

The server clears the harness flag but does **not** touch `data/colony.json` — the page is its
only writer. It is told through `unarchivedByActivity`, and `applyThreads` forgets those ids and
saves:

```js
const revived = list.filter((t) => t.unarchivedByActivity && state.archived.includes(t.id))
```

This depends on [04](04-thread-liveness.md): `lastActivityAt` must include the transcript's
mtime, or resuming a thread in a terminal never registers as activity and the archive sticks.

## Verification

| Check | Before | After |
| --- | --- | --- |
| Phantom untitled threads | 16 | 0 |
| Ids in the archive list that came back unflagged | 4 (stale scan) → 0 | 0 |
| Terminal-only threads archivable | 0 of 72 | 72 of 72 |
| Subagents archivable | 148 | 0 |
| Live workers whose parent is archived | 131 | 0 |
| Live threads overall | 334 | 203 |
| An active archived session (13 `bot-crossing` threads) | invisible, unrecoverable | back on the map, off the list, harness flag cleared |
| Restore rows in the panel | none | 12, plus "69 more archived" |

End-to-end, through the real endpoint on a terminal-only thread: archive returns
`{ ok: true, harnessRecord: false }`, and un-archiving immediately afterwards returns the same
— so the check leaves nothing retired.

## Edge cases

- **One writer for `data/colony.json`.** The page owns it and PUTs it whole; `/api/archive`
  must not touch it, or a save from a page holding older state drops every change since that
  page loaded.
- **The state schema is a whitelist** on both read and write. A new field must be added to
  `emptyState`, `readState` and `writeState` or it is silently dropped on the next save — see
  [06](06-ignoring-a-repo.md).
- **Never point a worker's `ref` at its parent.** One click on a worker would archive a live
  thread. Carry the parent as `parentRef` instead.
- **Every destructive gesture needs its inverse.** Archive existed for weeks with no undo; the
  first accidental `A` on a running thread is what surfaced it.
- **The revive rule and a running thread.** Archiving something that is still writing will
  bounce back on the next poll. That is intended — it is alive — but it is worth knowing before
  it looks like a bug.
