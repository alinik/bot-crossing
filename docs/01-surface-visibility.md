# Spec 01 — Who shows up on the surface

**Status:** implemented · **Depends on:** nothing · **Depended on by:** [02](02-task-type-zones.md), [03](03-subagents.md)

## Problem

The colony drew every thread the scanner returned. On a machine with a few hundred sessions
that is a list rendered in 3D, not a place: 398 threads, of which one was running and a
handful mattered. A session nobody has touched in half an hour is over, and drawing it spends
a building, a body and a slice of the map on something with nothing to say.

Two sub-problems came with it:

- The window was three days, which is not a working session's lifetime.
- Nothing decided how many bodies the surface could hold, so the roster could exceed the
  renderer's instance capacity — 306 threads counted, 90 astronauts drawn, with buildings,
  zones and the crew counter all claiming people who were not there.

## Design

One ordered function decides who is on the surface, and the world and the sidebar both read
it. Two settings drive it, because how much of your own thread list you want standing in front
of you is a taste, not a fact.

**Active** (default) — a thread is out if it is *running*, if it is *asking for you* (a reply
wanted, or stuck on an error), or if anything touched it inside the idle window. Everything
else is dormant and stays off the surface entirely: no building, no astronaut, no count, and
not in the zone sidebar's thread list.

**All** — every thread that is not archived, dormant ones included.

Nothing is deleted either way. A thread left off is still scanned and walks back down the ramp
the moment it earns a place.

### Ranking

The survivors are sorted before they are drawn, because the renderer's crew capacity cuts the
roster from the end:

```
CUT_ORDER = ['working', 'blocked', 'waiting', 'celebrating', 'idle', 'sleeping']
```

Ties break on `lastActivityAt`, newest first.

This is deliberately **not** `STATUS_ORDER`, which the sidebar uses and which leads with
`blocked` then `waiting`. Rank a capped surface that way and, on real data, 63 waiting threads
push the single running thread off the map. A cut that drops live work is the one outcome to
rule out.

## Implementation

### `src/core/settings.js`

Add to `DEFAULTS`, **outside** the `PRESETS` values — these are not quality knobs, and
applying a preset must not overwrite them:

```js
crewFilter: 'active', // or 'all'
idleWindow: 30,       // minutes of silence before a thread is dormant
```

### `src/game/colony.js`

1. `STALE_MS` becomes `30 * 60 * 1000` and is only the default; the window arrives as an
   argument.
2. `statusFor(thread, now, staleMs = STALE_MS)` — third parameter, used for the dormancy
   comparison, so the sidebar's labels and the world agree at any setting.
3. Add `CUT_ORDER` and:

```js
export function selectVisible(threads, { now = Date.now(), windowMs = STALE_MS, showAll = false } = {}) {
  const kept = []
  for (const thread of threads) {
    const status = statusFor(thread, now, windowMs)
    if (!showAll && status === 'sleeping') continue
    kept.push({ thread, status })
  }
  kept.sort((a, b) => {
    const rank = CUT_ORDER.indexOf(a.status) - CUT_ORDER.indexOf(b.status)
    return rank || (b.thread.lastActivityAt ?? 0) - (a.thread.lastActivityAt ?? 0)
  })
  return kept.map((entry) => entry.thread)
}
```

`statusFor` has already ruled out running, merged and unread by the time it says `sleeping`,
so one check covers "quiet past the window *and* asking for nothing".

4. In `setThreads`, before grouping:

```js
this.staleMs = Math.max(1, this.settings.get('idleWindow')) * 60 * 1000
const ranked = selectVisible(
  threads.filter((t) => !t.archived && !archivedIds.has(t.id)),
  { now, windowMs: this.staleMs, showAll: this.settings.get('crewFilter') === 'all' }
)
const live = ranked.slice(0, Math.max(1, this.settings.get('maxAgents')))
```

   Initialise `this.staleMs` in the constructor too, for anything that reads it before the
   first scan.

5. Every other `statusFor(thread, now)` call inside the class passes `this.staleMs`.

### `src/main.js`

- `statusFor(thread, now, colony.staleMs)` in the zone sidebar's thread list.
- The settings-change handler re-runs `applyThreads(threads)` when `maxAgents`, `idleWindow`
  or `crewFilter` moves, so a slider redraws from the list already in hand rather than waiting
  for the next poll.

### `src/ui/hud.js`

A **Who shows up** group at the bottom of the settings panel, below **View**:

- an Active / All chip pair bound to `crewFilter` (the existing `chips()` helper);
- an **Idle window** slider on `idleWindow`, 5–720 in steps of 5, formatted `30m` / `2h`, with
  the hint that it is ignored while All is on.

Rename the existing **Max crew** row to **Crew capacity** — with a second crew-shaped control
on screen, "max" reads as the same knob.

## Why the capacity cut moves into `setThreads`

`Astronauts.setRoster` already truncated at `maxAgents`, but by then the colony had built
buildings and zones for the whole roster and counted them all. Cutting the ranked list before
any of that keeps one invariant true: **counted equals drawn**.

## Verification

Measured on a real scan of 398 threads:

| Setting | On the surface |
| --- | --- |
| 24 h window (before) | 131 |
| 30 min window | 64, then 8 once [04](04-thread-liveness.md) landed |
| All, capacity 90 | 90 counted / 90 drawn |
| All, capacity 200 | 200 counted / 200 drawn |

Unit checks — `statusFor` and `selectVisible` are pure, so they can be extracted from source
and evaluated directly:

- 23 minutes quiet → `idle`, visible; 31 minutes → `sleeping`, hidden.
- A 5-day-old thread that is running, unread, errored or merged is still visible; those checks
  precede the staleness one.
- With a 3-slot cut over `[running, errored, old-unread]`, the running thread survives.

In the page, `window.botCrossing.colony.stats.agents` must equal the number of astronauts in
`colony.astronauts.agents` once movement settles.

## Edge cases

- **A slider is not a poll.** Changing any of the three keys must redraw immediately; without
  the change-handler wiring the panel appears broken.
- **`maxAgents` is a renderer limit, not a filter.** On All, what you see is the top
  `maxAgents` of the ranked list. Say so in the UI rather than pretending All is unbounded.
- **Never let two places decide state.** The sidebar and the world must call the same
  `statusFor` with the same window, or an astronaut will potter next to a panel saying it is
  blocked.
