# Agent Note: Web result card — a structured render intent for web_search and web_fetch

Status: implemented

English | [中文](2026-07-30-web-result-card.zh.md)

## Problem

The `web_search` and `web_fetch` tools each declared a generic pending card (`presentCall`, `kind: 'search'`/`'fetch'`) but no `presentResult`, so a completed web call reached a UI only as the model-facing render text. For a web frontend that wants to render a citation list or a fetch summary, that text is lossy: `web_search`'s render collapses each source's `title`, `snippet`, and `publishedAt` into one free-text markdown line labelled by title OR hostname (`formatSearchOutput` in `packages/web/tool-web/src/search.ts`), so reparsing the render cannot recover the per-source fields; and `web_fetch`'s render carries `url` and `statusCode` only in a header line. The render-intent contract ([tagged union](../architecture/2026-07-02-tool-render-intent-union.md)) had no arm a web tool could declare to carry a structured result.

## Decision

Add one `card: 'web'` result arm to `ToolResultView` (`packages/core/tools/src/presentation.ts`), a union `WebResultView = WebSearchResultView | WebFetchResultView` discriminated by a `kind: 'search' | 'fetch'` field, plus a `WebSource` shape for one citeable source. Both tools now declare `presentResult`.

One tag with a `kind` discriminant, not two tags. Both calls are web retrieval and a web frontend renders them with one component family (a retrieval card whose body differs by kind), so a shared `card` keeps every card consumer's switch to one added arm and lets the frontend branch on `kind` inside it. Two tags would force every present and future consumer to add two arms for what is one visual family. The `kind` values match the two tools' existing generic call-view `kind`s, so a call and its result read as the same category.

`presentationMeta` is mandatory here, not a convenience. The structured result object a tool returns from `execute` does NOT reach a client over the wire — only the model-facing `render` text and, when declared, the `output.presentationMeta` JSON projected onto the `tool/result` event's `meta` do. Because the render text is lossy for `web_search`'s sources, projecting the sources through `presentationMeta` is the only faithful route to `{url, title?, snippet?, publishedAt?}` at the consumer. This mirrors the write/edit diff template (`packages/fs/tool-fs/src/diff.ts`): a `*MetaFromValue` projector feeds `output.presentationMeta`, and a `*MetaFromResult` narrower reads `result.meta` back with a defensive fallback to the generic card. `web_fetch`'s meta carries `url`/`statusCode`/`truncated` only; its body is already markdown in the result content, so it is not duplicated into meta.

Each result view carries an optional `content?: ContentBlock[]` set to the model-facing result content. A UI without the `web` capability — including the TUI, whose transcript renderer has no `web` arm — renders that content through its existing generic/default path (`packages/ui/tui/src/components/transcript.ts`, `renderBody`'s `view.content ?? this.result?.content`), so the new tag needs no dedicated TUI arm and the TUI keeps compiling and rendering the text.

`presentResult` returns `undefined` (the generic card) on an error result and on absent or malformed `meta`, because presentation runs on replay of arbitrary logged results (possibly from an older schema) and must never throw. The narrowers validate every field defensively; an empty source list is valid meta, not malformed.

## Consequences

The web frontend consumer is a separate later PR: this PR adds the contract arm and makes the two tools emit it, with no client-side rendering. Any existing `ToolResultView` consumer that switches exhaustively must add a `web` arm; the TUI does not switch exhaustively and needs none. `apiproxy`'s session schema already accepts any `card` string (`packages/host/apiproxy/src/api/sessions.schema.ts`), so the new view crosses the wire without a schema change.

A future web tool that wants this card declares `presentResult` returning a `card: 'web'` view with its own `kind`; adding a third `kind` is a union edit plus the frontend's branch, not a new card tag.

## Alternatives considered

**Two card tags (`web-search`, `web-fetch`).** Rejected: it doubles the arm count at every card consumer for one visual family, and the two shapes already share enough (a titled retrieval card with fallback content) that a `kind` discriminant expresses the difference without a second tag.

**Reparse the render text in `presentResult` instead of projecting meta.** Rejected for `web_search`: the render's source list is lossy (title-or-hostname label, snippet and date concatenated into free text), so reparsing cannot faithfully recover the structured fields. `presentationMeta` is the only route that preserves them.

**Carry the fetch body in meta too.** Rejected: the body is already the model-facing markdown in the result content, and duplicating it into meta would double the persisted payload for no gain; the view points a UI at the existing content.

## Testing

`packages/web/tool-web/tests/tool-web.spec.ts` covers, per-file to the 100% gate: `searchMetaFromValue`/`fetchMetaFromValue` projection including omission of absent optional fields; `searchMetaFromResult`/`fetchMetaFromResult` narrowing with a round-trip and every malformed-shape rejection (non-object, wrong field types, a malformed source entry) plus the empty-source-list accept; `presentSearchResult`/`presentFetchResult` typed views including the truncated signal, the error-result fallback, and the malformed-meta fallback; and two real-registry executions asserting the tool projects the meta onto `result.meta` and its registered `presentResult` derives the `card: 'web'` view.

## Related

- [Tagged render-intent union for tool-call presentation](../architecture/2026-07-02-tool-render-intent-union.md) — the `card`-tagged vocabulary this extends with the `web` arm.
- [Web terminal card](2026-07-28-web-terminal-card.md) — the precedent that carried the bash `terminal` render intent to the browser; the web frontend consumer of this arm is its analogue, deferred to a later PR.
</content>
</invoke>
