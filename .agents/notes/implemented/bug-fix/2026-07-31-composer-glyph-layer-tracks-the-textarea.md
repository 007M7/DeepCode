# Agent Note: The composer's glyph layer tracks the textarea's scroll offset

Status: implemented

English | [中文](2026-07-31-composer-glyph-layer-tracks-the-textarea.zh.md)

## Problem

A composer draft longer than the 14-line cap could not be scrolled. The caret moved and the selection moved, but the words stayed frozen at line 1 — no wheel gesture, drag, or arrow key brought the end of a long draft on screen, so the bottom of anything past ~14 lines was unreachable and unreadable while writing it.

The cap itself was working. The composer paints its text in two stacked layers ([InputBar](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.tsx)): the `<textarea>` owns the value, the selection, and the caret but renders its own glyphs `color: transparent`, and every visible character is painted by the `[data-input-backdrop]` div beneath it, which also carries the claim-token highlight, the chips, and the ghost hint. That split is what makes chips and highlights possible at all — a textarea cannot style a range of its own text.

The two layers were coupled in geometry but not in scroll. The backdrop is `position: absolute; inset: 0; overflow: hidden`: it is clipped, not scrolled, and nothing in the browser links its offset to the textarea's. Below the cap that is invisible, because both layers rest at offset 0 and the mirror div sizes the box to the draft. At the cap the textarea starts scrolling and the backdrop does not follow, so the layer the user actually reads never moves.

The defect is therefore exactly as old as the cap, and it hid behind the resting state: a short draft, the state every screenshot and every existing fixture captured, renders identically with and without the coupling.

## Decision

`InputBar` mirrors the textarea's `scrollTop` onto the backdrop from one `scroll` listener, registered beside the existing wheel-chaining listener in the same effect (the textarea is never unmounted — the inert state renders the same element disabled).

One listener is the whole coupling, because every way the box moves ends in a `scroll` event on the textarea. A gesture scrolls it; an edit scrolls the caret into view; a draft that shrinks past the current offset clamps it. The clamp case is the one that looks like it needs separate handling and does not: the two layers share an extent — measured equal in chromium for plain, soft-wrapped, and unbreakable-run drafts — so they clamp to the same maximum, and the textarea's clamp fires the `scroll` that mirrors it.

The mirror is one-directional: the textarea is the authority because it owns the caret, and the caret is what the browser scrolls to.

## Alternatives considered

**Give the backdrop `overflow: auto` and let it scroll itself.** It would then have a scroll offset of its own to keep in step, which is the same problem plus a second scrollbar painted over the input. The backdrop is a projection of the textarea, not an independently navigable surface.

**Drop the backdrop and style the textarea's own text.** This removes the layer split and the whole class of desync with it. Rejected because it is not implementable: a textarea renders one uniform text run, so the claim-token highlight, the chips, and the ghost hint — the reasons the backdrop exists — have no way to be expressed. Losing them to fix scrolling trades a bounded defect for a feature deletion.

**Render the draft in a `contenteditable` div instead of a textarea.** One element, one scroll offset, styleable ranges. Rejected as far out of proportion to the defect: `contenteditable` would put IME composition, undo/redo, selection semantics, and paste normalization back on us, all of which the textarea plus the input machine currently handle, and the machine already owns an undo log that assumes a textarea's value semantics.

**Scroll the backdrop from the existing wheel handler instead of a `scroll` listener.** The handler already runs on every wheel over the textarea, so it looks like the natural place. Rejected because it covers only one of the ways the box scrolls: typing at the end, `End`, arrow keys, drag-selection past the edge, and scrollbar drags all move the textarea without a wheel event. Listening to `scroll` is listening to the thing itself rather than to one of its causes.

**Add a second mirror in a layout effect keyed on the committed draft.** This shipped in the first version of the change, on the theory that an edit reflows both layers without necessarily moving the textarea, and that a shrinking draft clamps each layer independently. Both premises are false, and it was removed after mutation-testing each hook alone against the built client: with only the layout effect disabled the browser scenario stays green, while disabling only the `scroll` listener fails it. Typing scrolls the caret into view, which is an ordinary `scroll`; a shrinking draft clamps both layers to the same maximum because their extents are equal, and the textarea's clamp fires `scroll` too. The specific hazard the effect was imagined to cover — React replacing the backdrop's children when the decoration set changes shape, resetting its offset — does not occur: measured in chromium, replacing every child of an `overflow: hidden` box preserves `scrollTop` (300 stays 300), and the only replacement that zeroes it is one that shrinks the content below the offset, which is the clamp case already covered.

**Sync in the `onChange` handler.** Rejected for the same reason plus one of its own: it fires before React commits the new draft to the backdrop, so it would mirror against the previous layout.

## Consequences

- A draft past the cap scrolls its glyphs. Measured in the browser scenario: after a wheel gesture over a 40-line draft the last line sits inside the visible box and the first has scrolled out above it; before, the last line stayed a full draft-height below the box while the textarea's own offset had moved.
- The coupling is one-directional and cheap — one assignment of one number, no measurement, no layout read beyond `scrollTop` — so it adds nothing to the typing path's cost.
- Chips, claim-token highlights, and text-ref marks stay aligned with their glyphs while scrolled, because they are positioned inside the backdrop and move with it. Nothing about the decoration walk changes.
- The composer's two-layer design keeps this hazard: any future layer added beside the backdrop needs the same mirroring. The e2e scenario asserts the relation the user cares about (which line is on screen) rather than the mechanism, so it holds whatever the layer count becomes.

## Testing

The unit spec in [input-bar.spec.tsx](../../../../packages/client/ui-conversation/tests/input-bar.spec.tsx) proves the mirroring path runs: it stubs both offsets, because jsdom reports `scrollHeight === clientHeight` for every element and never scrolls one, and asserts the backdrop follows the textarea to a new offset and back to the top. Reverting the `ref` makes it fail.

The user-visible fact needs a real engine, so [composer-draft-scroll.e2e.ts](../../../../apps/web/tests/composer-draft-scroll.e2e.ts) measures it in chromium against the built client: a 40-line draft in a fresh workspace's blank composer, zero model calls, with a DOM Range over the backdrop's own text reporting where the first and last lines sit relative to the visible box. A vacuity guard asserts the draft actually overflows the capped box first.

Confirmed both directions against the built client. With the mirroring reverted and the packages rebuilt, the wheel case fails on the layer offsets, the typing case fails with it, and the golden diff reads `last draft line is on screen: false` while `textarea moved: true` — the reported symptom stated as a fixture. The resting-state case passes in both builds, which is the point: it is the state that hid the defect.

Note that the composer ships inside a client-module bundle, so `pnpm run build:web` alone does not pick up a change to `InputBar.tsx` — the package build must run for the browser lane to see it, and a scenario run against a stale `lib/` asserts against an older client than the tree.
