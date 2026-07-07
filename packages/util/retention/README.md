# dsh-retention

A dependency-light **retention** library: bounded model-facing output for tools that must cap how much context they return. A caller feeds items or text chunks into a bounded object, gets a per-push decision about whether the upstream may stop, and later gets the retained content plus exact or partial omission metadata.

The library owns **only** the mechanical question *"what did we keep, what did we omit, and may the caller stop reading now?"*. Tool-specific code keeps its business semantics: file grouping, line numbering, exit codes, provider error states, per-line preview truncation, spill files, and the model-facing prose. This is the boundary the [RFC](../../../docs/rfc/implemented/architecture/2026-07-06-tool-result-retention-library.md) draws.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, emits no events. The only state is per-retainer (one accumulation), never cross-call. Tool packages import it directly.

## Surface

```ts
import {
  ItemRetainer, TextRetainer,
  describeOmitted, formatRetentionNotice,
} from '@deepseek-ai/dsh-retention'
import type {
  Omitted, PushDecision, RetainedItems, RetainedText,
  ItemRetentionStrategy, TextRetentionStrategy, StopMode, RetentionNotice,
} from '@deepseek-ai/dsh-retention'
```

| Export | Role |
|---|---|
| `ItemRetainer<T>` | Bounds ordered logical units (paths, grep matches, sources). `head` only in v1. `push()` → `PushDecision`; `finish()` → `RetainedItems<T>`. |
| `TextRetainer` | Bounds a byte-oriented text stream. `head` / `tail` / `headTail`, UTF-8 boundaries preserved at `finish()`. `push()` → `PushDecision`; `finish()` → `RetainedText`. |
| `describeOmitted(omitted, unit)` | Standardized, false-precision-safe omission clause (`exact` prints a count; `atLeast`/`unknown` do not). |
| `formatRetentionNotice(notice, recovery)` | Joins the standardized omission clause with the tool's own recovery guidance. |
| `Omitted` | `none` / `exact` / `atLeast` / `unknown` — how much was omitted, and whether the count is a lower bound. |
| `PushDecision` | `{ kept, truncated, shouldStop }` — the per-push control-flow result. |

## The two resource modes

The two retainers are separate names, not one generic collector, because they differ in **resource model** — and that difference is the whole point of the `shouldStop` field.

- **`ItemRetainer` can stop the upstream early.** With `stop: 'stopWhenFull'`, the first over-cap unit is a *probe*: it is not retained, sets `truncated`, and returns `shouldStop: true`. A discovery tool uses that to kill ripgrep / cancel a stream the moment truncation is proven, instead of collecting everything and trimming afterward. Because it stopped before the true total was known, `omitted` is `{ kind: 'atLeast', count: 1 }` — a lower bound, never a false-precise exact count.
- **`TextRetainer` tail/headTail must read to the end.** A true tail is unknowable until the stream closes, and draining avoids pipe backpressure on a child process, so `tail` and `headTail` never set `shouldStop` and report an `exact` omitted byte count. Only `head` + `stopWhenFull` can stop a text stream early.

`shouldStop` is **advisory**: the retainer cannot reach the upstream. The tool owns the actual stop — abort the HTTP body, break the scan, kill the process group.

## `truncated` is a budget fact, never "incomplete"

`truncated` means *the retainer omitted otherwise-available content because of a budget*. It does **not** mean the upstream was incomplete. Permission failures, skipped binary files, provider partial failures, unreadable candidates, and invalid UTF-8 stay in tool-domain fields — never folded into `truncated`. Conflating the two is the bug this library's naming most invites; keep them separate.

## Bytes, not characters

Text caps and `omittedBytes` count **bytes**, for process/body safety (a child's pipe and an HTTP body are byte streams). A chunk that straddles a codepoint is handled: `finish()` trims a partial codepoint at each cut so the returned text never introduces a replacement char at the boundary, and the two sides are decoded separately so a codepoint is never reconstructed across the omitted middle. Character- or line-level preview budgets are a separate, tool-owned concern.

## Tool mappings

Every current retention consumer maps to the library below; each row states whether it may stop its upstream early. A broad migration is out of scope for the library's first landing — these are the intended shapes.

| Tool | Retainer & strategy | Stops upstream early? | Notes |
|---|---|---|---|
| `glob` | `ItemRetainer<FsGlobEntry>`, `head` + `stopWhenFull` | **Yes** — the `(maxItems+1)`th path is the probe; `shouldStop` kills ripgrep. | Path mapping, skipped candidates, `incomplete` stay outside. `omitted` is `atLeast`. |
| `grep` | `ItemRetainer<FlatGrepMatch>`, `head` + `stopWhenFull` | **Yes** — cap is total matches; stop on the probe match. | Per-match preview truncation, then push a flat match; group + sort the retained subset *after* `finish()`. |
| `bash` | `TextRetainer`, `tail` or `headTail`, reads to completion | No — stopping would lose the true tail and risk pipe backpressure. | Executor still owns spill files, exit status, signal, timeout, background tasks. |
| `web_fetch` | `TextRetainer`, `head` (streaming provider) | Optional — a streaming body can stop; a decode-internally provider keeps its own cap. | The fetch result's `truncated` remains a provider/tool fact. |
| `web_search` | `ItemRetainer<WebSearchSource>`, `head` | Post-hoc today (providers return arrays); a streaming provider can use `stopWhenFull`. | Standardizes the "sources capped" notice. |

`read` is **intentionally out of scope for v1.** Its `read-render` helper owns a file-specific pagination contract — `offset`/`limit`, line numbers, `totalLines`, offset-out-of-range errors, per-line preview truncation, a byte cap over the selected window — which is a line-window renderer, not generic retention. A single `Omitted` count cannot represent both sides of a line window.

## Usage shape

```ts ignore-check
// glob: stop ripgrep the moment truncation is proven.
const retainer = new ItemRetainer<FsGlobEntry>({ kind: 'head', maxItems: globMaxResults, stop: 'stopWhenFull' })
for await (const entry of candidates) {
  const { shouldStop } = retainer.push(entry)
  if (shouldStop) { killRipgrep(); break }        // the tool owns the actual stop
}
const { items, truncated, omitted } = retainer.finish()

// bash: keep a head + tail, read to process exit.
const out = new TextRetainer({ kind: 'headTail', headBytes: headCap, tailBytes: tailCap })
child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })   // shouldStop ignored: must drain
const { text, omittedBytes } = out.finish()

// A footer: the library standardizes the omission clause; the tool owns recovery words.
const footer = formatRetentionNotice(
  { scope: 'grep', strategy: 'head', unit: 'items', limit: grepMaxMatches, kept: items.length, omitted },
  ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
)
```
