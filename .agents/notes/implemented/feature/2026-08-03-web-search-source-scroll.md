# Agent Note: Web search source card scrolls instead of collapsing

Status: implemented

English | [中文](2026-08-03-web-search-source-scroll.zh.md)

## Problem

The `web_search` result card (`WebBlock`, `packages/client/ui-primitives/src/WebBlock.tsx`) rendered its source list with a head/tail collapse: past a `maxSources` count (16 in the details panel, 8 in the chat row via `CHAT_WEB_MAX_SOURCES`) it drew the first `ceil(max/2)` sources, an `… 其余 N 条来源` expand button, then the last `max - ceil(max/2)`, mirroring `TerminalBlock`'s output cap. A user reading the card saw `来源列表已截断` and assumed the frontend had dropped sources it was holding.

It had not. The seam (`capSources`, `packages/web/web/src/index.ts`) cuts the provider's sources to the tool's `searchMaxResults` bound (default 8) and sets `truncated`, and that one capped list feeds both the model-facing render text and the card's `presentationMeta`. The card never holds more sources than the model saw. So the collapse was hiding sources the user was entitled to see in full — and, with the default bound at 8 and the panel cap at 16, it almost never even triggered, leaving only the `truncated` note with no way to reveal anything.

## Decision

`WebBlock`'s search arm renders every source it receives in one `<ol className={css.sources}>`, with no head/tail slicing, no expand button, and no `maxSources` prop. `.sources` (`WebBlock.module.css`) gets a fixed `max-height` and `overflow-y: auto`, so a list longer than the card height scrolls in place rather than growing the card or hiding rows. The height is a design constant of the card geometry, so it lives in CSS, not a plugin config field.

The model side is unchanged: the seam still caps sources at `searchMaxResults`, the model-facing render text is untouched, and the `truncated` flag and its `来源列表已截断` indicator stay. What the model sees and what the card shows remain the same list — the card just shows all of it, scrollable, instead of collapsing the middle.

`CHAT_WEB_MAX_SOURCES` and the primitive's `DEFAULT_WEB_MAX_SOURCES` are removed: with scroll, the chat row and the details panel show the same full list, differentiated only by their container height. `<li value={ordinal}>` still pins each source's 1-based citation index; without the collapse gap the ordinals are now simply contiguous.

## Alternatives considered

**Raise `searchMaxResults` (or make it unbounded) so more sources reach both the model and the card.** Rejected by the user: it changes model-side behavior (more sources into every request's context, more tokens) and breaks the invariant that model-visible and frontend-visible sources are identical. The instruction was explicit — keep the cap and the truncation, add a scrollbar.

**Keep the head/tail collapse and add scroll only to the expanded region.** Rejected: two overlapping mechanisms for one concern. Once the whole list is always rendered, the collapse arithmetic, the expand/collapse state, and the button are dead weight; scroll alone bounds the height.

**Make the scroll height a plugin config field.** Rejected: the height bounds the card's on-screen geometry, not a deployment policy, so per [web-card-model](2026-07-30-web-result-card.md)'s precedent for `CHAT_WEB_MAX_SOURCES` it belongs in CSS as a design constant.

## Testing

`packages/client/ui-primitives/tests/web-block.spec.tsx` drops the collapse cases (head/tail slice, expand-on-click, collapsed-tail numbering, expander-out-of-numbering, head-alone, default cap) and adds: a 30-source card renders all 30 `<li>` with no `[aria-expanded]` and no `<button>`, every `<ol>` child is a source `<li>`, and `<li value>` numbers 1..N contiguously. `packages/client/ui-conversation/tests/web-card.spec.tsx` drops the `CHAT_WEB_MAX_SOURCES` cap assertion; the WebRow expansion test still asserts the card shows every source field. The `packages/web/tool-web` tests are unchanged — the model side did not move.

## Related

- [Web result card](2026-07-30-web-result-card.md) — the `card: 'web'` render-intent arm and `presentationMeta` route this card consumes; the source of the capped-once list.
