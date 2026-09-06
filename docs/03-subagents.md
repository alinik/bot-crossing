# Spec 03 — Subagents as their own crew

**Status:** implemented · **Depends on:** [01](01-surface-visibility.md), [02](02-task-type-zones.md) · **See also:** [05](05-archiving-integrity.md)

## Problem

A thread that fans out with the `Agent` tool looked exactly like one busy thread. Ten workers
hammering for twenty minutes read as a single astronaut, which is the least informative moment
in the whole colony to have nothing to show.

The reason was a scan depth. Claude Code writes each subagent its own transcript one directory
deeper than a thread's:

```
~/.claude/projects/<project>/<parentSessionId>/subagents/agent-<id>.jsonl
```

`scanTranscripts` walked one level (`listFiles` is not recursive), so those files were never
indexed. On the machine this was built for: 347 transcripts on disk, 140 of them subagents,
none of them visible.

## Design

Every worker becomes an astronaut in a **yellow suit**, working on its parent's zone. The crew
wear five shades of off-white, so one colour is enough to say *these belong to that one* at any
zoom, without a badge competing with the `?` over a thread that actually wants you.

A worker is not a thread, and four rules follow from that:

| Rule | Because |
| --- | --- |
| It stands on its **parent's zone** | The crowd around one building is the thing worth seeing |
| It takes its **parent's repo**, not its own directory's | A worker usually runs in a worktree or scratch folder |
| It is `working` or nothing — never waiting, blocked or celebrating | Only a thread you can be *in* can ask you a question |
| It is on the surface **only while running** | It cannot want a reply and has nothing to open |

## Implementation

### `server/harnesses/claude-code.mjs`

**Scan.** Add `scanSubagentTranscripts()`, walking `<projectDir>/<sessionId>/subagents/`:

```js
const id = `${parentId}:${agentId}` // the agent id is a hash; the parent keys it too
out.set(id, { id, agentId, parentId, file, projectDir, size, mtime })
```

Guard the parent directory name with the `UUID` test so ordinary files are not mistaken for
session folders.

**Build.** One thread per worker, after the desktop and CLI passes so parents already exist in
`byId`:

```js
subagent: true,
parentId: entry.parentId,
source: 'subagent',
hasTranscript: true,
sizeBytes: entry.size,
transcriptFile: entry.file,
hasLiveProcess: live.has(entry.parentId), // it runs inside its parent's process
title: meta.firstPrompt ? meta.firstPrompt.slice(0, 90) : 'Subagent',
```

`unread` stays false: the finalisation loop only sets it for threads with desktop records.

**Inherit the parent.** After every thread is built, walk `byId` once:

```js
for (const thread of byId.values()) {
  if (!thread.subagent) continue
  const parent = byId.get(thread.parentId)
  if (!parent) continue
  thread.project = parent.project
  thread.projectPath = parent.projectPath
  thread.worktree = parent.worktree
  thread.parentDesktopId = parent.desktopSessionId || ''
  thread.parentCliId = parent.cliSessionId || ''
}
```

**Expose.** In `toThread`, strip the private fields and emit:

```js
canOpen: t.subagent ? openable(parentDesktopId, parentCliId) : openable(desktopSessionId, cliSessionId),
canArchive: !t.subagent,
ref: { desktopSessionId, desktopSessionIds, cliSessionId },
...(t.subagent ? { parentRef: { desktopSessionId: parentDesktopId, desktopSessionIds: [], cliSessionId: parentCliId } } : {}),
```

### `src/game/task-types.js`

Inside `zonesFor`, a worker takes its parent's task type when the parent is in the same
project's list:

```js
const parentOf = new Map(threads.filter((t) => t.subagent && t.parentId).map((t) => [t.id, t.parentId]))
// ...
const type = (parent && typeById.get(parent)) || typeById.get(thread.id)
```

### `src/game/colony.js`

`statusFor` gets a first branch, ahead of everything:

```js
if (thread.subagent) {
  if (thread.running) return 'working'
  return now - thread.lastActivityAt > staleMs ? 'sleeping' : 'idle'
}
```

`selectVisible` drops any non-running worker in Active mode:

```js
if (!showAll && thread.subagent && status !== 'working') continue
```

Roster entries carry `subagent: Boolean(thread.subagent)` through to the renderer.

### `src/agents/astronauts.js`

```js
const SUBAGENT_SUIT = 0xe8b93c
```

Used in `_spawnAgent` in place of the hashed `SUIT_TONES` pick, and re-checked in
`_updateAgent` (with `colorDirty = true` on change) so a scan that first saw a worker without
its parent still ends up yellow.

### `src/ui/hud.js` and `src/main.js`

- A `↳ subagent` tag in the thread card's meta row.
- The Open button relabels to **Open parent** with a matching tooltip.
- The Archive button disables itself when `canArchive === false`, and
  `actions.archiveThread` refuses the same case, because `A` on the keyboard bypasses the
  button.
- `src/game/api.js`: `openThread` posts `ref: thread.parentRef || thread.ref`.

## Why `parentRef` is not `ref`

`ref` is what archiving writes through. If a worker's `ref` pointed at its parent so that Open
worked, one click on a worker would archive a live thread. Keep the worker's own `ref` empty
and carry the parent separately.

## Verification

| Check | Result |
| --- | --- |
| Subagent transcripts scanned | 148 |
| Sharing their parent's project | 148 / 148, 0 mismatches, 0 orphans |
| In an attention state (`waiting`/`blocked`) | 0 |
| `canOpen` / `canArchive` | 148 / 0 |
| Active mode, live fan-out | 6 workers out, all `running`, all yellow (`e8b93c`) |
| All mode | 77 workers out of 90 drawn |

Unit checks:

- 13 "builds" threads plus two workers whose own prompts read as *reviews* and *infra* all land
  on `ws › builds`; a worker whose parent is absent falls back to its own type.
- A worker flagged `unread`, `hasError` or `prState: 'MERGED'` all resolve to `idle`; ordinary
  threads still resolve to `waiting` / `blocked` / `celebrating`.
- Active keeps a running worker and drops one that finished two minutes ago; All keeps both.

## Edge cases

- **The parent's liveness is not the worker's.** `hasLiveProcess` from the parent only says the
  worker *could* be running; [04](04-thread-liveness.md) decides whether it actually is. Without
  that, finished workers hammer for the whole idle window.
- **Titles are raw prompt text.** Most worker transcripts carry no description, so a title reads
  `STAGE 1 — INVESTIGATE AND PLAN ONLY…`. A few carry the parent's `Agent` tool call with a real
  `description`, which could be preferred when present. Not done.
- **A worker cannot be archived**, and archiving its parent retires it — see
  [05](05-archiving-integrity.md).
- **Duplicate agent ids** appear across parent sessions on real disks, which is why the map key
  includes the parent.
