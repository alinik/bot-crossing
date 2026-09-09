# Harness adapters

A **harness** is whatever runs the agent threads you want to see as astronauts — Claude Code,
Codex CLI, OpenCode, and so on. Bot Crossing does not care which one you use: it asks every
harness present on the machine for its threads and draws whatever comes back.

Adding one is meant to be **one new file in this directory**, plus one line in `index.mjs`.
Nothing in `server/scan.mjs`, `server/api.mjs`, or anywhere under `src/` should need to change.
If you find yourself editing those to land a harness, that is a bug in this seam — please say so
in the PR, because the next person will hit it too.

## The shape of it

```js
// server/harnesses/my-harness.mjs
export default {
  id: 'my-harness',              // stable, kebab-case, used as a key — never change it later
  name: 'My Harness',            // what a human sees in the UI
  detect,                        // () => Promise<boolean>
  scanThreads,                   // () => Promise<Thread[]>
  openThread,                    // (ref) => { ok, url } | { ok: false, error }
  newSession,                    // (dir) => { ok, url } | { ok: false, error }
  usage,                         // optional: () => Promise<Usage | null>
}
```

Then, in `index.mjs`:

```js
import myHarness from './my-harness.mjs'
export const HARNESSES = [claudeCode, myHarness]
```

### `detect()`

Is this harness on this machine at all? Usually just "does its data directory exist". Cheap —
it runs on every scan, so that installing a harness while the colony is open is noticed on the
next poll. Returning `false` means the harness is skipped entirely, and no astronaut for it
ever appears.

### `scanThreads()`

The real work: return one `Thread` per session the harness knows about.

Throwing is survivable — the scanner logs it and carries on with the other harnesses, so one
broken adapter costs you its own threads and nothing else. Prefer that over returning junk.

### `openThread(ref)` / `newSession(dir)`

Return `{ ok: true, url }` and the server hands that URL to the OS opener. `openThread` gets
the `ref` from the thread it belongs to; `newSession` gets an absolute directory that the
server has already checked still exists.

If your harness has no deep link, return `{ ok: false, error: '…' }` and say why — the UI
shows the message rather than pretending the click worked.

### There is no `setArchived`, and that is deliberate

Bot Crossing does not write to a harness. Not the transcripts, not the session records, not one
flag. Archiving is recorded in `data/colony.json` and nowhere else: the thread leaves the map and
the astronaut walks back to the ship.

It used to write one flag — `isArchived` on Claude Code's own session record — and that write
genuinely landed on disk. It just did not *mean* anything: the desktop app serves from the copy it
loaded at launch, so the thread stayed in its list until the app restarted, and the app rewrote the
record from memory the next time it touched the thread. Holding that together took a re-assert on
every scan, a `ps` sweep to guess whether the app had re-read the file, and a *pending* state for
the gap between them. All of that is gone, and the scan no longer starts a subprocess at all.

Archiving in the harness's own UI still works and is still the right way to do it — your adapter
reports it through the `archived` field and the astronaut goes home on the next poll.

### `usage()` — optional

A harness that knows what the account has left of its limits can say so. Everything about it
is optional — a harness without a `usage` shows nothing, rather than the colony inventing a
number — and nothing may be fetched: answer from whatever your own tooling has already cached
on this machine.

```js
async function usage() {
  return {
    fetchedAt: 1788691865947,   // epoch ms — when the reading was taken, not when it was read
    source: 'ccstatusline',     // shown on the panel, so two sources can be told apart
    limits: [
      { kind: 'session', group: 'session', label: 'Session', used: 92,
        severity: 'critical', resetsAt: 1788706800086, scope: '' },
      { kind: 'weekly_all', group: 'weekly', label: 'Weekly', used: 45,
        severity: 'normal', resetsAt: 1789038000086, scope: '' },
    ],
  }
}
```

`used` is a **percentage of the window spent**, not tokens: that is what these APIs report and
there is no token figure on disk to convert it from. `fetchedAt` is mandatory in spirit — the
panel stamps the reading with its age and marks it stale past ten minutes, because a cache
presented as live is a lie with a number on it. `scope` names a model when the limit is
per-model, so it can be shown as "Weekly · Opus".

Return a window that has just rolled over — a percentage with no reset time — rather than
dropping it: the panel shows that as `window not started`, and a row that vanishes at the moment
it resets reads as a bug. Drop only *scoped* windows with no reset time; those are limits the
account does not have.

An adapter may read more than one source. Merge them **per window**, taking each from the most
recent source that reports it, and report the age of the oldest reading you used.

## The `Thread` your adapter returns

Only `id` is truly required, but the colony gets duller the more you leave out — `project` is
what earns a repo its own zone, and `lastActivityAt` is what sorts the whole map.

### Return one thread per conversation, not one per record

If a harness writes more than one record for the same conversation — the Claude desktop app
writes a fresh one every time you resume a thread — merge them before returning. Whatever key
they share is the thread; a record with no title, no transcript and no live process behind it
is bookkeeping, not a session, and the adapter drops it.

Two things go wrong if you do not. An archived conversation comes back as a nameless twin,
because archiving names the ids the *real* record carried and the empty one was never in that
list. And the colony draws an astronaut with nothing to show for itself, which reads as a bug
in the world rather than in the scan.

| Field | Type | What it means |
| --- | --- | --- |
| `id` | string | **Unique across every harness.** A UUID is fine; otherwise prefix it, e.g. `my-harness:1234` |
| `title` | string | Thread title. `'Untitled thread'` if the harness has none |
| `preview` | string | First prompt, trimmed — shown on the thread card |
| `project` | string | Repo/folder **name**. This is what claims a hex zone |
| `projectPath` | string | Absolute path to the repo root |
| `worktree` | string | Worktree name, or `''` |
| `cwd` | string | Where the thread is actually working |
| `gitBranch` | string | Branch name, or `''` |
| `model` / `effort` | string | Shown on the thread card |
| `createdAt` | number | Epoch ms |
| `lastActivityAt` | number | Epoch ms. Sorts the colony and decides dormancy — see the idle window under **Who shows up** |
| `lastFocusedAt` | number | Epoch ms, `0` if unknowable |
| `running` | boolean | Working **right now** — the astronaut hammers away. A live process is not enough: a session sitting at its prompt is not running, so check that the thread is mid-turn. A thread whose own subagent is running counts as running: it is waiting on the worker, not on you |
| `unread` | boolean | Wants you — moved on since you last looked, or handed the turn back and is waiting on a reply. The astronaut stops and holds a `?`. Never set it on a thread with a running subagent, and never on a worker |
| `hasError` | boolean | Errored — the astronaut slumps, red eyes |
| `group` | string | Optional. A group the user put this thread in, if the harness has such a thing. It outranks `project` when zoning — a group is deliberate, a working directory is not |
| `groupId` | string | Optional, required with `group`. The group's stable key: zones are remembered by it, so a renamed group keeps its place |
| `subagent` | boolean | This thread is a worker its parent spawned. Drawn in a yellow suit, on the parent's zone, and never openable |
| `parentId` | string | The thread that spawned it, when `subagent` is set. Give a subagent its **parent's** `project`/`projectPath`, not its own working directory's — a worker usually runs in a worktree or a scratch folder |
| `parentRef` | object | Opaque ref for the *parent*, when `subagent` is set: opening a worker opens the thread that spawned it. Keep it apart from `ref`, and leave a worker's own `ref` empty |
| `starred` / `routine` / `prState` | | Optional extras; `prState: 'MERGED'` triggers the confetti — `statusFor` compares it exactly |
| `archived` | boolean | Archived in the harness's own records. Read-only — reporting it is all an adapter does |
| `sizeBytes` | number | Transcript size. **This is how finished a building looks**, on a log scale |
| `source` | string | Free-form, for your own bookkeeping (the Claude adapter uses `desktop` / `cli`) |
| `canOpen` | boolean | Whether this thread can be opened. The UI greys the button out |
| `ref` | object | **Opaque.** Whatever *you* need to find this thread again |

### About `ref`

`ref` is the whole reason the browser does not know what a session id looks like. Your adapter
puts whatever it needs in there, the page hands it straight back on open and archive, and
nothing between the two ever inspects it.

Keep it small and keep it serialisable — it makes a round trip through JSON on every action.
Do not put a file handle, a class instance, or a secret in it.

## Ground rules

- **Read-only. No exceptions.** `data/colony.json` is the only file Bot Crossing writes,
  anywhere. A harness's transcripts and records are somebody's actual work; the colony is a
  viewer, not an editor. If an adapter seems to need a write, it does not — say so in an issue.
- **Never run anything out of another application's bundle.** Not to read from it, not to
  execute it. Only files under the user's own home directory. Opening a thread goes through a
  URL the OS resolves, or a command the user already has on `PATH`.
- **Never block the scan.** It runs on a poll. Cache anything expensive against file mtime —
  see `transcriptMeta` in `claude-code.mjs`, which is what keeps a 12MB transcript from being
  reparsed every few seconds.
- **Read heads, not whole files.** `readHead` in `../lib/fsutil.mjs` pulls the first chunk and
  drops a trailing partial line, so `JSON.parse` never sees half a record.
- **Expect malformed data.** A session being written *right now* is a normal thing to trip
  over. Skip that record and move on; do not throw the pass away.
- **Read only what you need to.** `usage()` is the one method that may look outside the
  harness's own session store — the Claude Code adapter reads two caches another tool on the
  machine already wrote. Never fetch, and never touch credentials: if the answer is not already
  on disk, the colony does without it.
- **Never widen `id` collisions.** The colony keys its archive list and saved layout on `id`.
  Two harnesses handing back the same id would merge two unrelated threads into one astronaut.

## Starting points

Verified on a real machine:

- **Claude Code** — desktop records in
  `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`
  (`%APPDATA%\Claude\claude-code-sessions\…` on Windows); CLI transcripts in
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; live processes in
  `~/.claude/sessions/*.json`. Implemented in `claude-code.mjs`.
- **Codex CLI** — transcripts in `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`,
  with records shaped `{ timestamp, type, payload }`, and what looks like an index at
  `~/.codex/session_index.jsonl`. Not implemented yet.

For anything else, the fastest way in is usually to start a throwaway session in that harness
and watch which files change:

```bash
find ~ -maxdepth 4 -newermt '-2 minutes' -type f 2>/dev/null | grep -iv Library/Caches
```

## Checking your work

There is no test suite to run yet. What the Claude Code adapter was verified against, and what
a new one should clear too:

1. `node --check server/harnesses/my-harness.mjs`
2. With the app running, `GET /api/harnesses` lists every registered harness and whether
   `detect()` found it. If yours is missing or `detected: false`, stop here — nothing else
   will work until it shows up:

   ```bash
   curl -s localhost:5274/api/harnesses
   ```
3. Scan straight from node and look at the result — the number should match what the harness
   itself reports, and no field should be `undefined`:

   ```bash
   node -e 'import("./server/scan.mjs").then(async m => {
     const t = (await m.scanThreads()).filter(x => x.harness === "my-harness")
     console.log(t.length, "threads"); console.dir(t[0], { depth: 4 })
   })'
   ```
4. `npm run dev`, then confirm the astronauts appear on the right plots, the thread card fills
   in, and Open does what you expect.
5. Archive one thread and check it shows as archived **in the harness's own UI**, not just here.
6. If you implemented `usage()`, `GET /api/usage` should report your harness with percentages
   that match whatever the harness's own tooling says:

   ```bash
   curl -s localhost:5274/api/usage
   ```
