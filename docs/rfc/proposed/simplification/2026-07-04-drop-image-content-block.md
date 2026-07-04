# RFC: Drop the `image` content block until a path can honor it

Status: proposed

## Problem

`ImageBlock` (`packages/llm/llm/src/types.ts`) has no production producer, and every consumer on every path DROPS it: the deepseek adapter's serializer skips image blocks (a documented MVP limitation), the pi-ai converter skips them as unrepresentable, the ACP codec neither advertises image prompt capability nor forwards image blocks outbound and REJECTS image prompt content inbound, and the compaction estimator charges a flat token constant and renders `[image]`. An `ImageBlock` constructed today would silently vanish from the wire — the vocabulary advertises a capability no path honors, which is the silent-data-loss shape AGENTS.md's defensive patterns warn against. The only constructors anywhere are tests pinning the skip/drop/estimate branches.

## Proposal

Remove `ImageBlock`, its `ContentBlockMap` entry, the explicit `image` estimate/placeholder arms in compact-basic, and the image-naming comments in the deepseek serializer's, pi-ai converter's, and ACP codec's default arms — those default arms already absorb the case the way they absorb any unknown block type. Update the vocabulary line in [architecture.md](../../../architecture.md), the block list in `packages/llm/llm/README.md`, the deepseek README's image-skip row, the pi-ai README's images-not-representable row, the compact-basic README's image-estimation and `[image]`-placeholder rows, the pastes in [core.md](../../../core-data-structures/core.md) and [llm-streaming.md](../../../core-data-structures/llm-streaming.md), and the type-equiv manifest; amend the [content-block vocabulary RFC](../../implemented/architecture/2026-06-11-content-block-vocabulary.md)'s block list and multimodal-home consequence per [implemented/AGENTS.md](../../implemented/AGENTS.md); drop or retarget the tests that construct image blocks to exercise the removed branches. The ACP codec's inbound rejection of image PROMPT content is unaffected — that guard is about protocol content a client can send regardless of our vocabulary, and it stays.

## Why not keep it?

This is the most contested cut in the batch. Multimodal input (screenshots) is a plausible near-term coding-agent feature, and the [content-block vocabulary RFC](../../implemented/architecture/2026-06-11-content-block-vocabulary.md) reserved the slot deliberately. Two responses. First, `ContentBlockMap` is merge-extensible by design: a real multimodal feature reintroduces `image` in core in the same coordinated change that maps it in the adapters, advertises and renders it in ACP, and prices it in compaction — the producer and its consumers arrive together, which is how the map is meant to grow. Second, the middle option — keep the type but make adapters throw UNSUPPORTED instead of silently dropping — converts this into exactly the shape the [request-knobs RFC](2026-07-04-drop-inert-request-knobs.md) argues against: surface whose only implementation is rejection. Absence (a compile error at the would-be producer) is strictly clearer than either silent loss or universal throw.

If review lands on keeping the slot, the fallback this RFC records is: keep `ImageBlock` but replace every silent skip with a loud rejection, and document that policy in the vocabulary — the current silent drop is the one state with no defender.

## Acceptance criteria

- No `ImageBlock` / harness `type: 'image'` block construction outside this RFC; the codec's inbound ACP-image rejection still passes its tests.
- Adapter/codec/compaction switches handle the case through their unknown-block default arms (pinned by the existing plugin-added-block tests where present).
- Doc pastes, the manifest, and the architecture vocabulary list updated; `pnpm run doc-sync` green.

## Risks

Re-adding a core vocabulary type later touches several packages at once — but that coordinated change is the shape a real multimodal feature needs anyway (adapter mapping, ACP advertisement, compaction pricing), and none of it exists today to preserve.
