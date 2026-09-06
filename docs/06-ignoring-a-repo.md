# Spec 06 — Taking a repo off the map

**Status:** implemented · **Depends on:** [01](01-surface-visibility.md), [02](02-task-type-zones.md)

## Problem

Some folders are not work: a bot's own workspace, a scratch directory, a state folder some
skill writes into. `observer-sessions` produced 57 threads that were never going to be opened
by a human, and it claimed a zone whenever any of them was recent.

Archiving them one at a time does nothing — the next thread that folder produces puts the zone
straight back.

## Design

A named list of repos the colony looks past entirely. An ignored repo has no zone, no crew, no
counts, and nothing in any list. It is **still scanned**, so nothing is lost and nothing is
written to the harness; un-ignoring brings its threads straight back to the ground they were on,
because the layout memory is untouched.

The list lives in `data/colony.json` beside the layout, not in browser settings, so the choice
follows the colony rather than the browser it was made in.

## Implementation

### `server/api.mjs`

The state file is a whitelist on **both** read and write. All three places need the new field
or it is silently dropped on the next save:

```js
const emptyState = () => ({ version: STATE_VERSION, archived: [], archivedAt: {}, opened: [],
  ignored: [], plots: {}, seen: {}, settings: null, updatedAt: 0 })

// readState
ignored: asArray(raw.ignored),

// writeState
ignored: asArray(next.ignored),
```

### `src/main.js`

Seed the local state shape with `ignored: []`, then filter before the colony ever sees the
threads:

```js
const ignored = new Set(state.ignored || [])
const stats = colony.setThreads(
  ignored.size ? list.filter((t) => !ignored.has(t.project)) : list,
  archivedSet
)
```

Filtering on `project` rather than on zone key is deliberate: it takes a repo's split zones
([02](02-task-type-zones.md)) and its subagents ([03](03-subagents.md)) with it, since both
carry the parent repo's `project`.

Two actions:

```js
ignoreProject: () => {
  const repo = colony.plots.get(selectedProject)?.project
  // add to state.ignored, queueSave(), deselect, close the sidebar, applyThreads(threads)
},
restoreProject: (repo) => {
  // remove from state.ignored, queueSave(), applyThreads(threads)
},
```

And push the list at the HUD on every `applyThreads`: `hud.setIgnored(state.ignored || [])`.

### `src/ui/hud.js`

- An **Ignore this repo** button in the zone sidebar, under the folder actions, using the
  existing `ICON.eyeOff`.
- An **Ignored repos** row in the **Who shows up** settings group, holding one chip per ignored
  repo; clicking one calls `actions.restoreProject(name)`. The row is `hidden` while the list is
  empty, so it costs nothing until it is used.
- `setIgnored(names)` early-returns on an unchanged signature, like the other setters.

## Verification

Through the real button, on a live instance:

| | Before | After |
| --- | --- | --- |
| `observer-sessions` on the map | yes | no |
| `data/colony.json` → `ignored` | `[]` | `["observer-sessions"]` |
| Restore chip showing | — | yes |
| Its threads still returned by `/api/threads` | 57 | 57 |

The last row is the point: the scan is untouched, so this is reversible and nothing on disk
changes.

## Edge cases

- **Zone count can rise when a repo is ignored.** Crew capacity backfills the freed slots with
  threads from other repos, so more zones appear. Expected, and worth not mistaking for a bug.
- **Ignoring is by repo name, not path.** Two checkouts sharing a basename are disambiguated by
  `disambiguateProjects` in `server/scan.mjs` before this sees them, so the name in the list is
  whatever the map shows.
- **A repo with nothing left standing keeps its remembered position**, so restoring one puts it
  back where it was rather than reseeding it in the middle.
