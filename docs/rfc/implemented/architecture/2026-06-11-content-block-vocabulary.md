# RFC: Provider-neutral content-block vocabulary owned by dsh-llm

Status: implemented

## Problem

The harness needs one internal language for messages that the loop, session log, and all plugins speak.

## Decision

Own the vocabulary: messages are arrays of typed content blocks (`text`, `reasoning`, `tool-call`, `tool-result`), with the union derived from the merge-extensible `ContentBlockMap` so plugins add block types via declaration merging. The same merge-extensible-map pattern types every "stringly" field (`MessageSource`, `FinishReason`, `TurnTrigger`, `TurnEndReason`). Streaming is a raw chunk protocol; `BlockAssembler` is the single shared assembly implementation. Adapters translate to provider wire formats — mapping cost lives in adapters, where it belongs.

In-session context injection (`context/message`, `steering/message`) renders as tagged user-role envelopes (the system-reminder pattern) rather than a new role, so adapters carry zero burden. Live-adapter review has since validated the tagged-envelope rendering against current DeepSeek behavior; a future provider-specific mismatch should be handled in that adapter rather than by adding a new role to the canonical content vocabulary.

## Alternatives considered

- **Mirror the DeepSeek/OpenAI chat-completions shape** — zero mapping cost for the first provider, but awkward for rich content (reasoning, tool results as structured blocks).
- **Adopt Anthropic's Messages block structure verbatim** — battle-tested, but the canonical types would mirror a third-party API the harness does not target first.

## Consequences

- Reasoning has a home without provider contortions. Multimodal content deliberately has NO core block type: the core set is limited to blocks every shipping path honors, and a multimodal feature adds its block type through the merge-extensible map in the same coordinated change that maps it in the adapters, surfaces it in the UI bridges, and prices it in compaction — see [the drop-image RFC](../simplification/2026-07-04-drop-image-content-block.md). Block cache hints likewise have no core field: DeepSeek prompt caching is automatic, so no shipping adapter can transmit a hint; a caching feature adds a `cache` field together with the adapter that honors it — see [the producer-less-variants RFC](../simplification/2026-07-04-prune-producerless-vocabulary-variants.md). Assistant-prefix continuation (prefill) likewise has no request field: DeepSeek's chat-prefix completion is a Beta feature on a base URL neither shipping adapter targets, so a prefill feature adds `GenerateOptions.prefill` together with the adapter that honors it — see [the inert-request-knobs RFC](../simplification/2026-07-04-drop-inert-request-knobs.md).
- Every adapter pays a translation cost; the first real adapters have since validated the streaming protocol, and new adapters should continue proving their provider-specific mapping in adapter-local tests.
- IDs that cross package boundaries are branded (`CallId`, `SessionId`, `AgentId`) — nominal typing at zero runtime cost.
