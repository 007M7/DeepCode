# RFC: Prune producer-less vocabulary variants (block cache hints, the `agent` message source, the `continuation` turn trigger)

Status: proposed

## Problem

The merge-extensible vocabulary maps are designed to grow by declaration merging, and the codebase already states the admission policy on `TurnEndReasonMap` (`packages/core/session/src/types.ts`): a variant like `refusal` is "deliberately omitted until" an adapter or loop first emits it. Three declared vocabulary items violate that policy — each has no producer and no consumer, and two have not even a test:

- **`CacheHint` and the three `cache?: CacheHint` fields** on `TextBlock`/`ToolResultBlock`/`ImageBlock` (`packages/llm/llm/src/types.ts`). Nothing constructs a block with `cache:` anywhere — src, tests, and doc pastes all come up empty — and neither adapter reads `.cache`: DeepSeek prompt caching is automatic, so the adapters map `prompt_cache_hit_tokens` OUT of responses without ever sending a hint IN. This is Anthropic-style `cache_control` surface with no provider that can honor it.
- **`MessageSourceMap.agent`** (`{ kind: 'agent'; agentId: string }`, same file). Zero constructors, tests included. Its intended producer shipped without it: the subagent backends send the parent's prompt to the child with no `source`, so it logs as `{ kind: 'user' }`, and the generic envelope renderer interpolates `source.kind` without ever routing on it. The variant is pasted into [core.md](../../../core-data-structures/core.md).
- **`TurnTriggerMap.continuation`** (`packages/core/session/src/types.ts`). The loop structurally cannot emit it — continuation happens *within* a turn as further steps, never as a new turn — and it constructs only `message` and `injection` triggers. The only writer is one hand-built test fixture that needs an arbitrary non-message trigger (`packages/support/llm-replay/tests/llm-replay.spec.ts`); the only production trigger reader, the ACP bridge, filters on `kind === 'message'`. The variant is pasted into [session.md](../../../core-data-structures/session.md).

## Proposal

Delete `CacheHint` with its three `cache?` fields, the `agent` message-source variant, and the `continuation` turn-trigger variant. Switch the llm-replay fixture to an `injection` trigger (any non-`message` trigger serves its purpose). Update the type-equiv pastes in [core.md](../../../core-data-structures/core.md) and [session.md](../../../core-data-structures/session.md) (and `scripts/type-equiv.manifest.json` where block identity shifts) in the same change, and amend the [content-block vocabulary RFC](../../implemented/architecture/2026-06-11-content-block-vocabulary.md)'s consequence line naming cache hints as having a home, per [implemented/AGENTS.md](../../implemented/AGENTS.md).

Each variant returns the day it gains a real producer, exactly as the maps are designed to grow: a caching feature re-adds `cache` together with the adapter that transmits it; subagent attribution re-adds `agent` together with the backend that stamps it and a consumer that routes on it; an auto-continue feature that genuinely starts new turns re-adds `continuation` with the plugin that emits it.

## Why not keep them?

The [content-block vocabulary RFC](../../implemented/architecture/2026-06-11-content-block-vocabulary.md) lists "cache hints … have a home" as a design consequence, and reserved slots do advertise intent. But an empty slot is contract surface every implementation and consumer must consider (must my adapter honor `cache`? must my renderer route `agent` sources?), and the sibling map's own JSDoc already rejects reservation-without-emitter — `refusal` and `max_turn_requests` are named as variants to add *when something first emits them*, not declared in advance. Holding already-declared dead variants to the same standard makes the vocabulary mean something: if it is in the map, something produces it.

## Acceptance criteria

- `rg` for `CacheHint`, the `agent` message-source spelling, and the `continuation` trigger spelling returns only this RFC.
- The core-data-structures pastes and the type-equiv manifest are in sync (`pnpm run doc-sync` green).
- The fixture asserts the same replay behavior with an `injection` trigger; the suite is green.

## Risks

None operational — nothing can construct these values today. The mirror-event removals (recorded in [the boundary-mirror RFC](../../implemented/simplification/2026-06-20-remove-agent-boundary-mirror-events.md) and [the stream-chunk RFC](../../implemented/simplification/2026-07-02-remove-stream-chunk-mirror.md)) touch only transient `agent/*` events, never the durable vocabulary, so there is no collision. Elsewhere in the vocabulary the admission policy already holds: `rejected`, `prompt/blocked`, and `hook/invoked`/`hook/result` each have live producers — this RFC extends the same bar to the three variants that lack one. If the [image-block RFC](2026-07-04-drop-image-content-block.md) ships first, one of the three `cache?` fields leaves with it; the two proposals are independent and compose in either order.
