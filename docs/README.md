# Specs

One file per feature, with the bugs that belong to it folded in. Each spec states the problem,
the design decision and its reasoning, the implementation, how it was verified, and the edge
cases that cost a round trip to find.

Written so they can be reapplied against a clean checkout without this session's context.

| # | Spec | What it covers |
| --- | --- | --- |
| 01 | [Who shows up on the surface](01-surface-visibility.md) | `selectVisible`, Active/All, the idle window, ranking, the crew-capacity cut |
| 02 | [A crowded repo splits by task type](02-task-type-zones.md) | `task-types.js`, zone key vs zone name, the `splitAt` setting |
| 03 | [Subagents as their own crew](03-subagents.md) | Scanning workers, yellow suits, parent zone and repo, what a worker may do |
| 04 | [Running means mid-turn, not merely open](04-thread-liveness.md) | Turn detection from the transcript tail; the `lastActivityAt` / `unread` split |
| 05 | [Archiving integrity](05-archiving-integrity.md) | Empty twin records, re-keyed archives, terminal-only threads, orphaned workers, un-archiving |
| 06 | [Taking a repo off the map](06-ignoring-a-repo.md) | The ignore list, and where colony state is whitelisted |
| 07 | [Helmets say which model](07-model-helmets.md) | Model family read off the transcript, tinted per family, one palette shared with the HUD |
| 08 | [What is left of your limits](08-usage-limits.md) | Session and weekly windows merged per window from two local caches, with their age and source |
| 09 | [A sidebar group is a zone](09-session-groups.md) | Desktop sidebar groups read out of the app's LevelDB; group beats repo when zoning |

## Apply order

01 → 02 → 03 → 04 → 05 → 06, then 07, 08 and 09 in any order. Each of the first six compiles and
runs on top of the last, and several bugs in the later specs only exist because of an earlier
one — 04's `unread` regression comes from 04's own timestamp fix, 05's dead Archive button comes
from 03's button work. 07 needs only 03; 08 stands alone; 09 needs 02, whose zone machinery it extends.

## Rules that came out of this work

These are the ones worth carrying into any change in the same area:

- **One function decides state.** The world and the sidebar both read `statusFor`. If two
  places can disagree about what a thread is doing, eventually they will, and an astronaut
  pottering next to a panel saying "blocked" destroys trust in everything else on screen.
- **Counted equals drawn.** Any cut on the roster happens before buildings, zones and stats are
  built from it.
- **A zone key is not a zone name.** The key is what the layout remembers; the name is for
  reading.
- **A thread's identity is not one id.** Match archives on every id a thread carries.
- **`ref` is a write capability.** Never point one at a thread you did not mean to change.
- **Signals are not states.** A live pid is not work in progress; a file's mtime is not "you
  have not read this".
- **Never present a cache as live.** If a number was read at some past moment, ship its age
  beside it and mark it when it goes stale — and when several caches answer, report the age of
  the *oldest* one you used, not the newest.
- **A row that disappears is worse than a row that says nothing.** A window missing from a
  source has rolled over, not ceased to exist; show it as not started.
- **One surface, one fact.** Trim says what a thread is doing, the body says whether it is a
  worker, the helmet says which model. Put two meanings on one surface and the legend stops
  being learnable.

## Verifying a change here

The pure functions — `statusFor`, `selectVisible`, `taskTypeOf`, `zonesFor` — can be extracted
from source and evaluated in plain Node, which is how every rule in these specs was checked
against real data rather than assumed.

The adapter half is checked against the live scan:

```bash
npm run dev
curl -s -H "Origin: http://localhost:5274" http://localhost:5274/api/threads
```

And the page exposes `window.botCrossing` (`colony`, `settings`, `hud`, `threads`, `poll`) for
reading the world's own state back — zone membership, astronaut counts, which suit an agent is
wearing.
