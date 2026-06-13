# ADR 0004: Provider-neutral content-block vocabulary owned by dsh-llm

Status: accepted (2026-06-11)

## Context

The harness needs one internal language for messages that the loop, session log, and all plugins speak. Options: mirror the DeepSeek/OpenAI chat-completions shape (zero mapping for the first provider, awkward for rich content), adopt Anthropic's Messages block structure verbatim (battle-tested, but our canonical types would mirror a third-party API we don't target first), or own a vocabulary.

## Decision

Own it: messages are arrays of typed content blocks (`text`, `reasoning`, `tool-call`, `tool-result`, `image`), with the union derived from the merge-extensible `ContentBlockMap` so plugins add block types via declaration merging. The same merge-extensible-map pattern types every "stringly" field (`MessageSource`, `FinishReason`, `TurnTrigger`, `TurnEndReason`). Streaming is a raw chunk protocol; `BlockAssembler` is the single shared assembly implementation. Adapters translate to provider wire formats — mapping cost lives in adapters, where it belongs.

In-session context injection (`context/message`, `steering/message`) renders as tagged user-role envelopes (the system-reminder pattern) rather than a new role, so adapters carry zero burden. TODO(review): revisit once the DeepSeek V4 adapter exists.

## Consequences

- Reasoning, prefill, cache hints, and multimodal content all have a home without provider contortions.
- Every adapter pays a translation cost; the streaming protocol carries a TODO(review) marker until the first real adapter validates it.
- IDs that cross package boundaries are branded (`CallId`, `SessionId`, `AgentId`) — nominal typing at zero runtime cost.
