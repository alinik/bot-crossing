# Spec 08 — What is left of your limits

**Status:** implemented · **Depends on:** nothing · **Touches:** the harness adapter interface

## Problem

The colony shows what your threads are doing but says nothing about the budget they are
spending. Checking how much of the session or weekly window is gone means leaving the colony
and running `/usage` in Claude Code.

## What is actually available

This decides what can honestly be shown, so it comes before the feature.

Two caches on a typical machine hold the answer, and neither is authoritative.

**Claude Code's own**, in `~/.claude.json` under `cachedUsageUtilization`:

```json
{
  "fetchedAtMs": 1788691865947,
  "utilization": {
    "limits": [
      { "kind": "session",       "group": "session", "percent": 34, "severity": "normal", "resets_at": "…" },
      { "kind": "weekly_all",    "group": "weekly",  "percent": 40, "severity": "normal", "resets_at": "…" },
      { "kind": "weekly_scoped", "group": "weekly",  "percent": 0,  "scope": { "model": { "display_name": "Fable" } } }
    ]
  }
}
```

It is refreshed only when the CLI happens to talk to the API, so it can be badly out. Measured
side by side it claimed **34%** of the session was spent while the true figure was **92%**, and
was 134 minutes old.

**`ccstatusline`'s**, in `~/.cache/ccstatusline/usage.json`. That is a status-line widget many
people already run; it calls `GET https://api.anthropic.com/api/oauth/usage` itself, with the
account's OAuth token from the macOS Keychain, on a **180-second** cache:

```json
{"sessionUsage":92,"sessionResetAt":"2026-09-06T14:59:59Z",
 "weeklyUsage":45,"weeklyResetAt":"2026-09-10T10:59:59Z",
 "weeklySonnetUsage":0,"weeklyOpusUsage":0}
```

Three constraints follow, and all three have to reach the screen:

- **Percentages, not tokens.** Both sources report a percentage of the window. No token figure
  exists anywhere on disk to convert from, so "12,000 tokens left" cannot be shown honestly.
- **Both are caches.** A number like this presented as current is a lie with a number on it, so
  the reading ships with its age and its source.
- **The colony fetches nothing.** It has no account, no token, and asks nobody. Reading a cache
  another tool on this machine already wrote is the same bargain as reading the harness's own
  session files.

### Why per-window rather than newest-file-wins

Neither cache is complete. The moment a five-hour window rolls over, ccstatusline's file stops
mentioning the session at all — `sessionUsage: 0` with no `sessionResetAt` — while the CLI's
older copy still carries the row. Taking the newer file wholesale drops Session off the panel
exactly when it resets, which reads as a bug.

So each window is filled from the freshest source that has it, each row carries the age of the
reading it came from, and the panel's age line reports the **oldest** contributing reading. A
scoped per-model window still needs a reset time to count as real, but the session and weekly
ones survive the rollover and render as `window not started` until the next message begins one.

## Refresh rate

Three clocks, and the slowest one wins:

| Step | Interval |
| --- | --- |
| The colony polls `/api/usage` | every 15 s, with the thread poll |
| `ccstatusline` refreshes its cache | ≥ 180 s, and **only when it runs** — i.e. when Claude Code draws your status line |
| Claude Code refreshes `~/.claude.json` | whenever it happens to talk to the API — hours, in practice |

So the panel reflects the files within 15 seconds, but it cannot make either file newer. While
you are actively prompting in a Claude Code terminal the reading is ~3 minutes old at worst;
while you are idle, or working somewhere that does not draw that status line, it ages, and the
age line says so.

## Design

Its own floating panel at the top left, opposite the sidebar rather than inside it — the
numbers are about the account, not about the colony, and are worth seeing without opening
anything. The left edge is otherwise empty above the vertically-centred rail, so it needs no
rule for the settings panel opening over the right.

```
Session  ▓▓▓▓▓▓▓▓▓░  92%
resets in 1h 40m
Weekly   ▓▓▓▓░░░░░░  45%
resets Thu 14:29
ccstatusline · as of 2m ago
```

- **Spent**, not remaining. Every other tool reporting this shows consumption, and a status line
  saying 92% beside a panel saying 8% is one fact wearing two faces.
- The bar fills as the window is used up — amber past 75%, red past 90% — so a full bar means
  trouble rather than plenty.
- The countdown reads `in 47m` / `in 3h 10m` while a duration still means something, then
  switches to `Thu 14:29`.
- The age line names its source and goes amber past 10 minutes: a three-minute cache is live
  enough to trust, and anything much older is not.
- A per-model window is labelled `Weekly · Opus`.

## Implementation

### `server/harnesses/claude-code.mjs` — one optional adapter method, two readers

Both readers cache by file mtime, since the poll runs every few seconds and the CLI config is
~280 KB.

```js
const CLI_CONFIG = path.join(HOME, '.claude.json')
const CCSTATUSLINE_CACHE = path.join(HOME, '.cache', 'ccstatusline', 'usage.json')

// ccstatusline's file carries no timestamp inside, so its mtime is the reading's age —
// accurate, because the tool rewrites the file on every refresh.
async function statuslineUsage() { /* → { fetchedAt: mtime, source: 'ccstatusline', limits } */ }
async function cliConfigUsage()  { /* → { fetchedAt: fetchedAtMs, source: 'claude-code', limits } */ }

async function usage() {
  const sources = (await Promise.all([statuslineUsage(), cliConfigUsage()]))
    .filter(Boolean)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
  if (!sources.length) return null

  // Each window from the most recent source that reports it; first writer wins per key.
  const merged = new Map()
  for (const source of sources) {
    for (const limit of source.limits) {
      const key = `${limit.kind}\u0000${limit.scope}`
      if (merged.has(key)) continue
      merged.set(key, { ...limit, source: source.source, fetchedAt: source.fetchedAt })
    }
  }

  const limits = [...merged.values()]
  return {
    fetchedAt: Math.min(...limits.map((l) => l.fetchedAt)), // the oldest, not the newest
    source: [...new Set(limits.map((l) => l.source))].join(' + '),
    limits,
  }
}
```

Each limit normalises to:

```js
{ kind, group, label, used, severity, resetsAt, scope }
```

`used` is a percentage 0–100, and each merged limit also carries the `source` and `fetchedAt`
of the reading it came from.

Both readers drop a **scoped** window with no `resets_at` — that is a limit the account does not
have, and the CLI config lists every kind the API knows about, most of them `null`. The session
and weekly windows are kept even without one, because that is exactly what a window looks like
in the minutes after it rolls over.

Exported from the adapter's default object as `usage`.

### `server/scan.mjs` — `harnessUsage()`

Aggregates across detected harnesses, skipping any without a `usage`, swallowing a thrown
adapter the same way `scanThreads` does. The API layer never imports `harnesses/` directly.

### `server/api.mjs` — `GET /api/usage`

```json
{ "usage": [ { "harness": "claude-code", "harnessName": "Claude Code",
               "fetchedAt": 1788700245383, "source": "claude-code", "limits": [ … ] } ] }
```

### `src/main.js` and `src/ui/hud.js`

`fetchUsage()` rides along with the thread poll — the underlying value is a cache refreshed on
someone else's schedule, so asking more often buys nothing. A failure is swallowed: the colony
does not depend on this, and an unreachable endpoint shows nothing rather than an error.

`hud.setUsage(report)` renders the panel, early-returning on an unchanged signature like the
other setters, and hiding itself entirely when there are no limits.

## Verification

Mid-window, against a real account and cross-checked against the same account's status line:

| | Session | Weekly |
| --- | --- | --- |
| `GET /api/usage` | `used: 92` | `used: 45` |
| Rendered | 92%, red bar, `resets in 1h 40m` | 45%, `resets Thu 14:29` |
| ccstatusline | 92% | 45% |

Across a rollover, which is the case the merge exists for — the five-hour window reset at 15:00
and ccstatusline's file stopped carrying the session at all:

```
sources: ccstatusline | oldest reading: 34.8 min
  Session    0% used  via ccstatusline (35m old)  resets = not started
  Weekly    46% used  via ccstatusline (35m old)  resets = yes
```

Both rows survived, with the session shown as `window not started` rather than disappearing.

The panel measured 208px wide at `top: 14, left: 14` — clear of the sidebar and above the
centred rail, no overlap. The source label is what makes the two-cache behaviour visible rather
than mysterious.

## Edge cases

- **A harness with no `usage`** shows nothing. Do not fall back to a guess.
- **Neither cache present** — same: the panel stays hidden.
- **`limit_dollars` / `used_dollars` are `null`** on a Max plan, so there is no money figure
  either.
- **A cache from before a reset** leaves `resetsAt` in the past, which reads `resets now`.
  Running `/usage` in Claude Code refreshes its file; `ccstatusline` refreshes its own every
  three minutes while your status line is drawing.
- **A window with no reset time at all** is a session that has rolled over and not restarted.
  It shows `window not started`, at 0%.
- **The two sources can disagree**, and badly — 34% against 92% at one point. The merge does
  not average or reconcile them: each window shows one source's answer, and says which.
- **Do not fetch.** The colony has no credentials and should never acquire any. This feature
  exists only because other tools already wrote the answer down.
