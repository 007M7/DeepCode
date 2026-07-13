# RFC: Drop the `image` content block until a path can honor it

Status: implemented

## Problem

`ImageBlock` (`packages/llm/llm/src/types.ts`) had no production producer, and every consumer on every path DROPPED it: the deepseek adapter's serializer skipped image blocks (a documented MVP limitation), the pi-ai converter skipped them as unrepresentable, the ACP codec neither advertises image prompt capability nor forwarded image blocks outbound and REJECTS image prompt content inbound, and the compaction estimator charged a flat token constant and rendered `[image]`. An `ImageBlock` constructed then would silently vanish from the wire — the vocabulary advertised a capability no path honored, which is the silent-data-loss shape AGENTS.md's defensive patterns warn against. The only constructors anywhere were tests pinning the skip/drop/estimate branches.

## Decision

Remove `ImageBlock`, its `ContentBlockMap` entry (and its `cache?: CacheHint` field with it), the explicit `image` estimate/placeholder arms in compact-basic, and the image-naming comments in the deepseek serializer's, pi-ai converter's, and ACP codec's default arms — those default arms absorb the case the way they absorb any unknown block type. Updated in the same change: the vocabulary line in [architecture.md](../../../architecture.md), the block list in `packages/llm/llm/README.md`, the deepseek README's image-skip row, the pi-ai README's images-not-representable row, the compact-basic README's image-estimation and `[image]`-placeholder rows, the pastes in [core.md](../../../core-data-structures/core.md) and [llm-streaming.md](../../../core-data-structures/llm-streaming.md), and the [content-block vocabulary RFC](../architecture/2026-06-11-content-block-vocabulary.md)'s block list and multimodal-home consequence per [implemented/AGENTS.md](../AGENTS.md); the tests that constructed image blocks to exercise the removed branches were dropped (the estimate pin) or retargeted onto the merge-extensible default arms (plugin-added block types). The ACP codec's inbound rejection of image PROMPT content is unaffected — that guard is about protocol content a client can send regardless of our vocabulary, and it stays.

## Alternatives considered

### Why not keep it?

This was the most contested cut in the batch. Multimodal input (screenshots) is a plausible near-term coding-agent feature, and the [content-block vocabulary RFC](../architecture/2026-06-11-content-block-vocabulary.md) reserved the slot deliberately. Two responses. First, `ContentBlockMap` is merge-extensible by design: a real multimodal feature reintroduces `image` in core in the same coordinated change that maps it in the adapters, advertises and renders it in ACP, and prices it in compaction — the producer and its consumers arrive together, which is how the map is meant to grow. Second, the middle option — keep the type but make adapters throw UNSUPPORTED instead of silently dropping — converts this into exactly the shape the sibling request-knobs proposal (`2026-07-04-drop-inert-request-knobs`) argues against: surface whose only implementation is rejection. Absence (a compile error at the would-be producer) is strictly clearer than either silent loss or universal throw.

The recorded fallback, had review landed on keeping the slot: keep `ImageBlock` but replace every silent skip with a loud rejection, and document that policy in the vocabulary — the silent drop was the one state with no defender. Review landed on removal; the fallback stands as the documented alternative should the slot ever return ahead of a full feature.

## Verification

No `ImageBlock` / harness `type: 'image'` block is constructed anywhere outside RFC records; the codec's inbound ACP-image rejection keeps its tests; and the adapter/codec/compaction switches handle the case through their unknown-block default arms, pinned by the plugin-added-block tests.

## Consequences

Re-adding a core vocabulary type later touches several packages at once — but that coordinated change is the shape a real multimodal feature needs anyway (adapter mapping, ACP advertisement, compaction pricing), and none of it existed to preserve.
