# Agent Note: Search render intent — grep and glob emit a structured search card

Status: implemented

English | [中文](2026-07-30-search-render-card.zh.md)

## Problem

`grep` and `glob` return structured canonical values — `grep` a flat `{ matches: [{ path, lineNumber, line }] }`, `glob` a `{ paths: string[] }` — but every UI only ever saw their model-facing render text: `grep` groups its matches under file headers with `Line N:` rows, `glob` prints a newline-joined path list, and both append a spill footer when the inline cap ({@link module:@deepseek-ai/dsh-tool-fs-search/grep} `grepMaxMatches`, default 250; {@link module:@deepseek-ai/dsh-tool-fs-search/glob} `globMaxResults`, default 100) drops later results to a spill file. A web frontend that wants to render a search result as an expandable per-file group of matches, or as a selectable path list, had to re-parse that text. Both tools already declared a call-time [render intent](../architecture/2026-07-02-tool-render-intent-union.md) (`GenericCallView`, `kind: 'search'`) but no result-time view, so the completed call fell back to the generic card that renders the raw text.

The structured canonical value does not cross the wire: only the model-facing render text and, when a tool declares `output.presentationMeta`, a JSON metadata payload reach the client, threaded through the `tool/result` event ([canonical-output contract](../architecture/2026-07-20-canonical-tool-output-contract.md)). A result-time view carrying structured data therefore has to project that data into `presentationMeta` and read it back in `presentResult` — the same path `write`/`edit` use for their diff cards.

## Decision

`packages/core/tools/src/presentation.ts` adds `card: 'search'` to the `ToolResultView` union as `SearchResultView`, a `kind`-discriminated view that expresses both tools' shapes: `SearchMatchesResultView` (`kind: 'matches'`) carries `grep`'s matches grouped by file as `files: { path, matches: { lineNumber, line }[] }[]`, and `SearchPathsResultView` (`kind: 'paths'`) carries `glob`'s flat `paths: string[]`. Both carry `truncated: boolean` and `total: number`, and an optional `content?: ContentBlock[]`.

One view with two shapes rather than two cards, because both tools are the same visual object — a search result — and a web consumer switches on one `card` value, then on `kind` for the row shape. The discriminated `kind` keeps each shape's fields non-optional (a matches view always has `files`, a paths view always has `paths`) instead of a single interface where every shape-specific field is optional.

The card tag is result-time only. A search call stays a `GenericCallView` (`kind: 'search'`): the pending state has no matches or paths to show, so there is nothing a `SearchCallView` would carry that the generic title does not. This is the asymmetry with the terminal card, whose call view carries the command, cwd, and description that exist before execution; a search's structured content exists only after `execute`.

`packages/fs/tool-fs-search/src/presentation.ts` owns the projection and the narrowing. `grepSearchMeta`/`globSearchMeta` project the canonical value into a `SearchMeta` payload each tool declares as `output.presentationMeta`; `presentGrepResult`/`presentGlobResult` read `result.meta` back through `searchViewFromMeta` and attach the model-facing `result.content` as the view's `content`. The projections apply the SAME inline cap and per-line preview budget the model-facing render applies, and report `total` as every result the search found (before capping) with `truncated` set when the cap dropped results. This is the truncation-honesty point: the model saw a capped inline result plus a spill footer, so the card must not present the retained page as the complete result — a UI reads `truncated`/`total` to show a capped indicator rather than claiming completeness the model never had.

`searchViewFromMeta` narrows the opaque `meta` defensively and returns `undefined` on any malformed or absent payload, exactly as `diffsFromMeta` does, so a presenter run on an older or hand-edited replayed log falls back to the generic card instead of throwing. `presentResult` returns `undefined` for a failed result, for absent meta (a nested `run_code` dispatch computes no `presentationMeta`), and for the other tool's meta shape (each presenter narrows to its own `kind`).

The `SearchMeta` member shapes are object-literal `type` aliases, not the `SearchFileMatches`/`SearchLineMatch` interfaces the view exposes. Only a type alias is assignable to the `JsonValue` index signature `presentationMeta` returns; the two are structurally identical, so the projected value still reads back as a `SearchResultView`.

The TUI (`packages/ui/tui/src/components/transcript.ts`) needs no dedicated arm: its result-view switch handles `terminal` and `diff` explicitly and falls through to a generic arm that renders `view.content ?? this.result?.content`. Because `SearchResultView` carries the model-facing text as `content`, the TUI renders it as the same text it already showed. The web frontend that renders the structured `files`/`paths` shape is a separate later PR; this PR is the backend contract and its two producers.

## Alternatives considered

**A single flat `SearchResultView` interface with optional `files?` and `paths?`.** Rejected: it makes both shape-specific fields optional on every value and lets a malformed view carry both or neither. The `kind` discriminant keeps each shape's fields required and lets a consumer switch exhaustively.

**A call-time `SearchCallView` mirroring the terminal card's both-sides symmetry.** Rejected: a search call has no matches or paths before `execute`, so the view would carry only the title the `GenericCallView` already carries. The terminal card's call view earns its tag because a command, cwd, and description exist at call time; a search's structured content does not.

**Carry the structured result in a bespoke channel instead of `presentationMeta`.** Rejected: the canonical value is execution-local and never reaches the client, and `presentationMeta` is the established seam that persists a tool's JSON presentation payload with `tool/result` and threads it back to `presentResult`. Adding a second channel would duplicate that path.

## Consequences

`grep` and `glob` now compute `presentationMeta` on every non-nested successful call, a bounded projection over the already-parsed matches or paths. The projection re-applies the retention cap the render already applied, so the retained set is computed twice per call; the input is bounded by the raw-output cap, so this is not a new scaling concern.

A UI without a search card renders the attached `content` text, so no consumer regresses. The web consumer that renders the structured shape reads `truncated`/`total` and the per-file groups; because the view carries only the retained page, a UI wanting the complete result follows the spill locator in the model-facing text, exactly as the model does.

## Testing

`packages/fs/tool-fs-search/tests/presentation.spec.ts` pins the pure layer: `groupMatchesByFile`'s first-seen file order, `grepSearchMeta`/`globSearchMeta` projection with the cap applied and `total` reporting the pre-cap count, the per-line preview budget on a projected match line, and `searchViewFromMeta`'s narrowing of both good shapes plus every malformed case (non-object/array meta, missing or mistyped `truncated`/`total`, unknown `kind`, malformed `files` entries, non-string `paths`). `packages/fs/tool-fs-search/tests/tools.spec.ts` pins the wiring through the real tool registry: a capped `grep`/`glob` execute produces the `SearchMeta` on `result.meta` and `presentResult` builds the search view with `content` attached, a nested `run_code` dispatch computes no meta so `presentResult` falls back, and a failed or cross-shape or malformed result falls back to the generic card. Per-file 100% coverage holds over the search package `src`.

## Related

- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md) — the `card`-tagged vocabulary this extends with the `search` result tag.
- [Canonical tool output contract](../architecture/2026-07-20-canonical-tool-output-contract.md) — the value/render/`presentationMeta` split this projection rides; the structured value stays execution-local, the card rides `meta`.
- [Web terminal card](2026-07-28-web-terminal-card.md) — the precedent this mirrors on the backend: a tool projects its result into `presentationMeta` and a `presentResult` view; the search card's web consumer is the analogous follow-up.
