# Spec 02 — A crowded repo splits by task type

**Status:** implemented · **Depends on:** [01](01-surface-visibility.md) · **Depended on by:** [03](03-subagents.md)

## Problem

A zone is a repo, which works right up until the repo is a *workspace*: a folder you start
sessions from that holds a dozen checkouts underneath it. Every one of those threads reports
the same directory, so they pile onto one enormous plot — PR reviews, ticket triage, incident
digs and one-off scripts standing shoulder to shoulder with nothing to tell them apart.

On the machine this was built for, `~/PycharmProjects` held 65 of 131 visible threads on a
single hex. The map was unreadable exactly where the work was.

## Design

Past a threshold, a repo becomes **one zone per kind of work**: `front-main › reviews`,
`PycharmProjects › incidents`, `PycharmProjects › /sentry-triage-resolve`.

The kind is read off the thread's own title, since that is the only field carrying intent:

1. **A skill or slash command**, if the title names one. Claude Code opens a skill thread with
   the skill's own preamble, which starts by naming its directory, so the path is the reliable
   half; a bare `/name` at the very start covers hand-typed ones. Labelled with its slash —
   `/fix` — so it never reads as the `fixes` keyword bucket a few tiles away.
2. **Otherwise an ordered keyword bucket** over title + preview, first match wins, most
   specific first: reviews → incidents → tickets → infra → fixes → reports → builds → misc.

Order is the point, and mirrors `statusFor`: "Review and merge CF-2237" is a review before it
is a ticket; "Fix comparison-bot crashloop using Loki logs" is an incident before it is a fix.

**The split is decided on the repo's whole size, not on each type's.** Otherwise a zone
dissolves back into its parent the moment one kind of work thins out, and a map is only worth
learning if it holds still.

## Prerequisite: a zone needs an identity separate from its name

Before any of this, plots were keyed by repo name — `plots.get(name)`, `thread.project ===
plot.name` — everywhere. A split zone has a key (`PycharmProjects›reviews`) that is not its
label (`PycharmProjects › reviews`), so the two have to come apart first. This is the larger
half of the change and is easy to under-scope.

| Field | Meaning |
| --- | --- |
| `Plot.id` | The zone key. What the layout memory stores and what every lookup uses. |
| `Plot.name` | The label. Read by humans only — the name plate, the sidebar heading, the legend row. |
| `Plot.project` | The repo behind the zone. Used for "new thread here" toasts and folder actions. |
| `colony.zoneOf` | `Map` of thread id → zone key, rebuilt on every scan. The single answer to "where does this thread stand". |

Then replace every `thread.project === plot.name` with `colony.zoneOf.get(thread.id) ===
plot.id`:

- `select()` — following an astronaut to its zone;
- `selectProject(id)` — the parameter is a key now, not a name;
- `pathForProject(id)` / `harnessForProject(id)` — the most common answer among the threads
  standing on that zone;
- the zone sidebar's thread list;
- legend rows, which carry `id` alongside `name`; `hud.setLegend(rows, activeId)` compares ids
  and `pickProject` passes an id;
- deck and name-plate clicks (`selectProject(plot.id)`);
- `#btn-locate` in the HUD, which passed `project.name` and would otherwise look a zone up by
  its label.

## Implementation

### New file: `src/game/task-types.js`

```js
export const SPLIT_AT = 12 // default only; the colony reads the `splitAt` setting

const SKILL_PATH = /skills\/([a-z0-9][a-z0-9._-]*)/i
const SLASH_COMMAND = /^\s*\/([a-z0-9][a-z0-9-]*)\b/i

const BUCKETS = [
  { key: 'reviews',   label: 'reviews',   test: /pull request|\bpr\b|\bmr\b|code review|\breview\b/i },
  { key: 'incidents', label: 'incidents', test: /sentry|crashloop|traceback|stack trace|exception|\bloki\b|\btrace\b|incident|outage/i },
  { key: 'tickets',   label: 'tickets',   test: /\b(cs|cf|bug|eb|ef|com|bc|dev|ai)-\d+\b|jira|ticket|backlog|triage/i },
  { key: 'infra',     label: 'infra',     test: /kubernetes|\bk8s\b|kubectl|cluster|namespace|\bpod\b|helm|deploy|bamboo|\bci\b|pipeline|rollout/i },
  { key: 'fixes',     label: 'fixes',     test: /\bfix(ed|es|ing)?\b|\bbug\b|broken|failure|regression|debug/i },
  { key: 'reports',   label: 'reports',   test: /report|analytics|baseline|audit|\bstats\b|summar(y|ise|ize)/i },
  { key: 'builds',    label: 'builds',    test: /implement|\badd\b|\bcreate\b|build|migrat|refactor|optimi[sz]e|\bfeature\b/i },
]

export function taskTypeOf(thread) { /* skill first, then buckets, else misc */ }

export function zonesFor(threads, splitAt = SPLIT_AT) {
  // group by project; a project at or under `splitAt` stays one zone
  // otherwise one zone per task type, keyed `${project}›${type.key}`
  // returns Map of key → { key, project, label, threads }, biggest first
}
```

The `›` separator cannot appear in a folder name or a skill name, so a split zone can never
collide with an unsplit one's key.

`taskTypeOf` returns `{ key, label }`: the key is what the layout remembers and must not drift
with wording; the label is what the name plate shows.

### `src/game/colony.js`

```js
const zones = zonesFor(live, this.settings.get('splitAt'))
this.zoneOf = new Map()
for (const zone of zones.values()) {
  for (const thread of zone.threads) this.zoneOf.set(thread.id, zone.key)
}
this._syncPlots(zones)
```

`_syncPlots` takes the zone map, allocates cells by `zone.key`, and constructs
`new Plot({ id: zone.key, name: zone.label, ... })` with `plot.project = zone.project`.
`stats.projects` counts zones.

### `src/core/settings.js` + `src/ui/hud.js`

```js
splitAt: 12, // threads on one repo before it splits; 0 never splits
```

A **Split a repo at** slider in the **Who shows up** group, 0–60, rendering `Never` at 0 and
`N threads` otherwise. Add `splitAt` to the keys that re-run `applyThreads` in `main.js`.

## Verification

On the real scan (131 visible threads at the time):

| `splitAt` | Zones |
| --- | --- |
| 0 (Never) | 13 |
| 5 | 23 |
| 12 (default) | 18 |
| 25 | fewer — big repos stop splitting |

`PycharmProjects` at 12 became: reviews 26, misc 12, tickets 7, incidents 5, builds 4, fixes 3,
infra 3, reports 2, `/sentry-triage-resolve` 2, `/fix` 1.

Unit checks against `zonesFor`:

- 20 threads with `splitAt` 0 → one zone; 5 and 12 → two zones; 25 → one zone.
- `taskTypeOf` precedence: `Review and merge CF-2237` → reviews, `Fix crashloop using Loki
  logs` → incidents, `BUG-12` → tickets, `Check pod health in namespace` → infra.

## Edge cases

- **Zone keys are layout keys.** Changing the key shape moves every zone on someone's map.
  Keys survive the `splitAt` slider moving, so a repo that splits, unsplits and splits again
  lands back on the ground it had.
- **Stale keys are harmless.** The layout memory holds 80 entries and ages out the oldest, so
  an unsplit repo's old key simply falls off the end.
- **Accents hash the zone key**, so slices of one repo get unrelated colours rather than shades
  of one. Tinting by `plot.project` would read better; not done.
