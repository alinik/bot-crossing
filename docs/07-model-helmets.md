# Spec 07 — Helmets say which model

**Status:** implemented · **Depends on:** [03](03-subagents.md) · **Related:** [04](04-thread-liveness.md)

## Problem

Which model a thread is running on was visible only by selecting it and reading a tag on the
card. Across a colony of a hundred astronauts there was no way to see the mix — how much of the
map is Opus, whether a fan-out is Haiku workers, whether a repo is being worked by one model or
four.

Underneath that was a data gap: only the desktop app records a thread's model. Threads started
in a terminal, and **every** subagent, arrived with `model: ''` — 222 of 538 threads on a real
machine, and 100% of workers.

## Design

Tint the **helmet** by model family.

| Family | Colour | |
| --- | --- | --- |
| Opus | `0x8f6ff0` | violet |
| Sonnet | `0x3aa6cc` | blue |
| Haiku | `0x4faf72` | green |
| Fable | `0xd4589a` | pink |
| unknown | the suit's own tone | off-white |

Three decisions, each of which could reasonably have gone the other way:

**By family, not by version.** `claude-sonnet-4-6` and `claude-sonnet-5` are the same thing to
someone glancing at a map, and a shade per point release is a palette nobody can hold in their
head. Matching is a regex against the model string, so a model id that has not been invented yet
still lands in the right family.

**Unknown keeps the suit tone.** A fifth "unknown" colour would make a missing field look like a
state. Falling back to the body's own off-white makes it read as unremarkable.

**The helmet specifically.** The other channels are taken and each carries one thing:

| Channel | Says |
| --- | --- |
| Trim + eyes | What the thread is *doing* — `AGENT_LOOK` per status |
| Body suit | Whether it is a worker — yellow, see [03](03-subagents.md) |
| Helmet | Which model is answering |

Three independent facts, three places to read them, none competing.

## Implementation

### `server/harnesses/claude-code.mjs` — close the data gap

The transcript's first assistant record carries `message.model`. Capture it in
`readTranscriptMeta`:

```js
const meta = { /* ... */, model: '' }
// in the record loop:
if (!meta.model && r.type === 'assistant' && r.message?.model) meta.model = r.message.model
```

Then use it at all three construction sites:

- desktop threads: `model: s.model || meta?.model || ''` — the record still wins;
- CLI threads: `model: meta.model || ''`;
- subagents: `model: meta.model || ''`.

The meta parse is already cached per transcript mtime, so this costs nothing extra.

### `src/agents/astronauts.js` — the palette

```js
const MODEL_TINTS = [
  [/opus/i, 0x8f6ff0],
  [/sonnet/i, 0x3aa6cc],
  [/haiku/i, 0x4faf72],
  [/fable/i, 0xd4589a],
]

export const MODEL_COLOURS = [['Opus', 0x8f6ff0], ['Sonnet', 0x3aa6cc], ['Haiku', 0x4faf72], ['Fable', 0xd4589a]]

export function helmetFor(model, suit) {
  if (!model) return suit
  for (const [test, hex] of MODEL_TINTS) if (test.test(model)) return hex
  return suit
}
```

An agent gains `helmet`, set in `_spawnAgent` *after* `suit` exists to fall back to, and
re-checked in `_updateAgent` (with `colorDirty = true` when it moves, so a thread that changes
model repaints). In the instanced write:

```js
crew?.setColorAt(i, c.setHex(agent.suit))
helmet.setColorAt(i, c.setHex(agent.helmet))   // was agent.suit
```

That write already only runs when `colorDirty` is set or an agent's slot moved, so per-frame
cost is unchanged.

### `src/ui/hud.js` — say what the colour means

- The thread card's model tag gains a swatch, drawn with the same `helmetFor` — one palette, so
  a card and a helmet can never disagree.
- The help sheet gains a row of the four names and their swatches, plus a line for the yellow
  suit, since both are colour-carrying rules a new viewer has no way to guess.

## Verification

Model coverage after the adapter change, on a 538-thread scan:

| Source | Missing model before | After |
| --- | --- | --- |
| desktop | 3 / 316 | 3 / 316 |
| cli | 71 / 71 | 3 / 71 |
| subagent | 148 / 148 | **0 / 148** |

Families found: sonnet 325, opus 114, haiku 59, fable 30, none 6, plus one `<synthetic>` that
correctly falls back to a suit tone.

In the page, with 90 astronauts drawn, every distinct helmet colour maps to exactly one family:

```
3aa6cc → 60 sonnet
8f6ff0 → 10 opus
d4589a → 18 fable
4faf72 →  1 haiku
dfe4e8 →  1 (none — a suit tone)
```

That grouping is the whole test: if a helmet colour ever covers two families, or a family shows
two colours, the mapping has drifted.

## Edge cases

- **A model string that names two families** — none exists today; the regex list is ordered, so
  the first match wins deterministically.
- **`<synthetic>` and other non-model values** appear in real transcripts. They fall through to
  the suit tone, which is the intended behaviour for "no answer".
- **The desktop record still wins** over the transcript, because it is what the app itself
  believes and it is correct for a thread whose model was changed mid-session.
- **Do not tint the body.** The body already carries worker-vs-thread; two facts on one surface
  is how a legend stops being learnable.
