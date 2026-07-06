# RFC: Tool result retention library

Status: proposed

## Problem

Several model-facing tools already bound the amount of context they return, but each one owns a different local mechanism and vocabulary: bash keeps a tail plus spill files, web search caps source lists, web fetch caps body content, and `glob` / `grep` discovery needs `cap + 1` early stop while reading ripgrep output. A single post-hoc `truncate(text)` helper cannot cover those cases: by the time `grep` or `glob` has collected every result, the expensive traversal has already happened and the process may have emitted more output than the harness intended to buffer.

The shared abstraction the tools need is **retention**, not generic collection. A caller feeds items or text chunks into a bounded object, receives a per-push decision about whether the upstream can stop, and later receives the retained content plus exact or partial omission metadata. Tool-specific code still owns business semantics: file grouping, line numbering, exit codes, provider error states, and model-facing prose. The common library owns only the mechanical question "what did we keep, what did we omit, and may the caller stop reading now?"

## Proposal

Add a small, dependency-light retention library under `packages/util/retention` (package name `@deepseek-ai/dsh-retention`). It exports pure item and text retainers plus notice helpers. It is not a Cordis service and registers no plugin; tool packages import it directly when they need bounded model-facing output.

The library has two independent retainers:

- `ItemRetainer<T>` handles ordered logical units such as paths, grep matches, or search sources. It supports `head` retention only in v1.
- `TextRetainer` handles byte-oriented text streams such as bash stdout/stderr or web response bodies. It supports `head`, `tail`, and `headTail` retention while preserving UTF-8 boundaries at `finish()`.

Both retainers return a `PushDecision` after each `push()`. `shouldStop` is the critical control-flow field: `glob` / `grep` use it to kill ripgrep once the probe item proves truncation, while bash ignores it because tail/head-tail retention must read to process exit to know the true suffix and to avoid pipe backpressure.

```ts ignore-check
/**
 * How much content the retainer omitted.
 *
 * `atLeast` is the early-stop shape: `glob` / `grep` see the first item past the cap,
 * stop the upstream process, and know only that at least one item was omitted.
 */
type Omitted =
  | { kind: 'none' }
  | { kind: 'exact'; count: number }
  | { kind: 'atLeast'; count: number }
  | { kind: 'unknown' }

/**
 * The caller receives this after each `push()`.
 *
 * `shouldStop` is advisory, not automatic: the tool owns how to stop its upstream
 * source, such as aborting an HTTP body, breaking a file scan, or killing ripgrep.
 */
interface PushDecision {
  kept: boolean
  truncated: boolean
  shouldStop: boolean
}

/**
 * Final result for ordered logical units.
 *
 * `seen` means units observed by the retainer, not necessarily total units in the
 * upstream source; with early stop, total is intentionally unknown.
 */
interface RetainedItems<T> {
  items: T[]
  truncated: boolean
  seen: number
  kept: number
  omitted: Omitted
}

/**
 * Final result for text streams.
 *
 * The returned `text` is safe to send to a formatter; the retainer does not add
 * tool-specific headers, exit markers, XML tags, or recovery instructions.
 */
interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: Omitted
}
```

### Strategies

The strategy names are caller-facing and avoid implementation phrases such as "overflow". `stopWhenFull` means the retainer should ask the caller to stop once keeping more would exceed the budget. `readToEnd` means the retainer must keep accepting input even after the retained output is full, usually to preserve a true tail, count exact omission, or drain an upstream process.

```ts ignore-check
type StopMode = 'stopWhenFull' | 'readToEnd'

type ItemRetentionStrategy =
  | {
      /** Keep the first `maxItems` units. Use for `glob`, `grep`, and web sources. */
      kind: 'head'
      maxItems: number
      stop: StopMode
    }

type TextRetentionStrategy =
  | {
      /** Keep the first `maxBytes` bytes. May stop an upstream body early. */
      kind: 'head'
      maxBytes: number
      stop: StopMode
    }
  | {
      /** Keep the final `maxBytes` bytes. Requires reading to the end. */
      kind: 'tail'
      maxBytes: number
    }
  | {
      /** Keep a stable prefix and suffix, omitting the middle. Requires reading to the end. */
      kind: 'headTail'
      headBytes: number
      tailBytes: number
    }
```

### Tool mapping

`read` is intentionally outside the v1 retention library. Its `read-render` helper owns a file-specific pagination contract: `offset` / `limit`, line numbers, `totalLines`, offset-out-of-range errors, per-line preview truncation, and a selected-output byte cap that can stop scanning mid-window. That is a line-window renderer, not a generic retention primitive. It may share future neutral notice helpers, but it should not pass its already-selected window through `ItemRetainer`.

`FsGlobEntry` and `FlatGrepMatch` below are the intended discovery-tool item shapes, not existing retention-library exports. `FsGlobEntry` is one backend-derived path, and `FlatGrepMatch` is one ungrouped grep match before the backend groups retained matches by file.

`glob` uses `ItemRetainer<FsGlobEntry>` with `{ kind: 'head', maxItems: globMaxResults, stop: 'stopWhenFull' }` inside the backend or executor that is consuming traversal output. The `(maxItems + 1)`th valid path is the probe item: it is not retained, it sets `truncated: true`, and `shouldStop: true` tells the caller to stop ripgrep, cancel a remote stream, or stop whatever upstream is producing candidates. `omitted` is `{ kind: 'atLeast', count: 1 }` because the traversal stopped before the full count was known. Path mapping, skipped candidates, and `incomplete` stay outside the retainer.

`grep` uses `ItemRetainer<FlatGrepMatch>` with `{ kind: 'head', maxItems: grepMaxMatches, stop: 'stopWhenFull' }` before grouping. The backend parses a ripgrep match record, maps the path, applies per-line preview truncation, then pushes a flat match. After `finish()`, the backend groups retained matches by file and sorts the returned subset. Grouping is not part of the retainer because the cap is total matches, not files; per-match preview truncation and `incomplete` are also separate from result-level retention.

`bash` uses `TextRetainer` with `tail` or `headTail` and reads to process completion. It does not stop when full: stopping the read would lose the real tail and can create pipe backpressure. The bash executor still owns spill files, exit status, signal, timeout, and background-task behavior; the retention helper only replaces ad hoc in-memory head/tail accounting where that behavior is desired. Long-running task ownership remains orthogonal to the [generic long-running tool runtime](2026-06-20-generic-long-running-tool-runtime.md) proposal.

`web_fetch` can use `TextRetainer` with `head` when the provider exposes a stream, or keep provider-owned body caps when the provider must read and decode internally. Either way, the fetch result's `truncated` remains a provider/tool fact, and the library only supplies retained text and omission metadata.

`web_search` can use `ItemRetainer<WebSearchSource>` with `head`. Current providers often return an array, so this is post-hoc but still standardizes notices; a streaming provider can use the same strategy with `stopWhenFull`.

### Notices

The library exposes a neutral notice shape and a tiny formatter hook, but tools provide the user-facing words. A grep footer says "Narrow the pattern, path, or include"; a web fetch footer says "Fetch a more specific URL or section"; bash may point to a spill file. The retainer cannot know those recovery actions.

```ts ignore-check
interface RetentionNotice {
  scope: string
  strategy: 'head' | 'tail' | 'headTail'
  unit: 'items' | 'bytes' | 'chars' | 'lines'
  limit: number | { head: number; tail: number }
  kept: number
  omitted: Omitted
}

const formatGrepNotice = (notice: RetentionNotice): string =>
  formatRetentionNotice(
    notice,
    ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
  )
```

The formatter hook is deliberately small: a tool turns a `RetentionNotice` into its own footer text. The helper may standardize omission wording, but it does not own recovery guidance.

`truncated` means the retainer omitted otherwise-available content because of a budget. It does not mean the upstream was incomplete. Tools keep separate fields for permission failures, skipped binary files, provider partial failures, unreadable candidates, invalid UTF-8, and any other "could not inspect" condition.

## Alternatives considered

**Post-hoc `truncate(text)` only.** Rejected: it matches Codex's history/tool-output truncation use case but fails the `glob` / `grep` resource model. The tool must stop ripgrep once the probe result proves truncation; collecting all output and trimming afterward defeats the point and can exceed the command runner's in-memory output cap.

**One generic `Collector<T>` with pluggable callbacks.** Rejected for v1: it hides the two important resource modes. Logical item retention can ask the caller to stop after a probe item; text tail/head-tail retention usually must read to the end. Separate `ItemRetainer` and `TextRetainer` names make that difference explicit while keeping the API small.

**Put `read` windowing behind `ItemRetainer`.** Rejected for v1: `read` is the only current window consumer, and its semantics are file pagination rather than generic retention. A single `Omitted` count cannot represent both sides of a line window, and `read` also carries `totalLines`, offset-range errors, per-line preview truncation, and a byte cap over selected output. Keeping `read-render` tool-owned avoids growing the shared library around one special case.

**Make truncation part of `ToolExecutionResult`.** Rejected: the tool registry would have to understand tool-specific recovery guidance, grouping, line numbering, exit status, and provider semantics. Retention is a library used before a tool returns `ContentBlock[]`; the model-facing result remains tool-owned.

**Expose limits in every model-facing tool schema.** Rejected as the default: Claude Code's grep exposes `head_limit` / `offset`, but this harness keeps routine budgets as deployment config unless the model genuinely needs pagination control. A future read-like continuation field can be added per tool; it does not belong in the shared retention primitive.

## Acceptance criteria

- A new `@deepseek-ai/dsh-retention` utility package exports `ItemRetainer`, `TextRetainer`, `RetainedItems`, `RetainedText`, the strategy types, `Omitted`, `PushDecision`, and neutral notice helpers without depending on Cordis or any tool package.
- Unit tests cover item-head early stop with a probe item, item-head read-to-end with exact omission counts, text-head early stop, text-tail retention with exact omission counts, head-tail byte retention, zero budgets, UTF-8 boundary handling, and the difference between `{ kind: 'atLeast', count: 1 }` and exact omission.
- `glob`, `grep`, `bash`, `web_fetch`, and `web_search` have documented mappings to the library before any broad migration begins; each mapping states whether it may stop upstream early. `read` is documented as intentionally out of scope for v1.
- Existing tool-specific states such as `incomplete`, provider failures, binary skips, and bash spill-path recovery remain outside the retention library.
- If the first implementation migrates an existing tool, that package's README and tests prove the model-facing result text is unchanged except for deliberate notice wording.

## Risks

- **Over-generalizing the v1 surface.** A generic callback-heavy collector would be harder to reason about than the duplicated code it replaces. The v1 surface deliberately supports only item `head` retention and text `head` / `tail` / `headTail`; windows, grouped budgets, and sort-aware caps can wait until a second consumer proves it needs them.
- **Conflating truncation with incomplete execution.** The library name may invite callers to stuff permission or provider partial failures into `truncated`. Tests and README examples must keep the rule explicit: retention budgets omit available content; incomplete inspection is a tool-domain state.
- **Byte-vs-character confusion.** Text retainers count bytes for process/body safety, while some model-facing previews care about characters or lines. The v1 API should make byte retention explicit and leave character-level preview helpers as separate functions.
- **False precision after early stop.** `glob` and `grep` cannot report exact omitted counts when they stop the upstream at the first overflow item. The `Omitted.atLeast` variant exists so formatters do not claim "omitted 1" when the true count may be much larger.
