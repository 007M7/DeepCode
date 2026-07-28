# Agent Note: Separate context injection from turn execution

Status: implemented

English | [中文](2026-07-24-separate-context-injection-from-turn-execution.zh.md)

## Problem

The agent API represented supplementary model-facing input in three overlapping ways: callers attached `HookContext[]` through `SendOptions.contexts`, interception and tool hooks returned `additionalContexts`, and plugins called `agent.inject()`. These paths eventually wrote context into the same model history, but carried different placement, metadata, admission, queue, and turn-lifecycle rules.

Atomic attachment to an inbox message forced the loop to preserve context through prompt admission, steering conversion, cancellation, and terminal discard. `prompt-prefix` placement then combined context and the direct prompt into one event, requiring a model-hidden envelope so transcript consumers could recover what the user actually wrote. The result made outbox entries, session projection, and UI replay responsible for a distinction that belongs to the producer.

Idle `inject()` exposed a second mismatch. Injection did not request model execution, yet the implementation opened and closed a zero-step `injection` turn solely to satisfy the turn-enclosure invariant and obtain a durability checkpoint. A turn therefore sometimes meant “run the agent loop” and sometimes meant “persist context without running it.”

`HookContext` also named its producer rather than its role. The value could come from a native plugin, a hook bridge, prompt admission, or tool post-processing; its stable meaning was additional model-facing context with provenance.

## Decision

`inject()` is the only caller-facing operation for supplementary model-facing input, and a turn means one execution of the model loop.

`SendOptions` contains only `target` and `wakeup`. A caller that owns context delivers an identified, frozen `UserMessage` through `inject()` and submits the direct message independently with `send()` or `steer()`.

Prompt and tool extension points still return `additionalContexts`. These values are outputs of the extension point, not attachments captured from a caller's inbox item. Prompt admission runs before `run()` opens a turn. An allowed prompt and its returned additional contexts enter the new turn as separate messages; a blocked prompt writes neither and opens no turn. Tool-produced additional contexts enter the outbox after the corresponding tool results.

Every additional context is an independent `user/message` whose `source` records provenance. There is no `context/message`, prompt-prefix placement, stable request delimiter, or prompt envelope. Transcript and UI consumers distinguish direct user messages from injected context by `source`.

## Injection lifecycle

During prompt admission or an open turn, `inject()` stages context in the loop outbox. The private next-step acceptance window opens before `agent/prompt-submit` and closes before `turn/end`, so steering and context accepted for one boundary reach the same following request while a `turn/end` listener's late steering becomes a queued prompt. The loop drains the outbox at a safe step boundary, preserving tool protocol adjacency: context accepted during an assistant tool-call batch appears only after that batch's complete ordered results.

Outside that window, `inject()` appends its `user/message` immediately. It does not increment turn numbering, emit `turn/start` or `turn/end`, change agent status, or run the model; persistence observes the append through `session/event`.

If prompt admission blocks or fails, a caller-staged context-only batch appends immediately without a turn. Steering and context staged beside it remain in the outbox for a later admitted prompt; cancellation or disposal may discard them. Hook-produced `additionalContexts` never materialize because they belong to the rejected admission decision.

The session invariant permits `user/message` between turns while continuing to require turn enclosure for core execution events, steering, assistant output, and tools. Merge-extensible event relations belong to their declaring plugin rather than a core default. Persistence, recovery, resume, fork, and compaction treat valid between-turn events as committed session history rather than an interrupted or discardable turn tail.

## Extension and caller semantics

`PromptDecision.content` continues to replace only the direct prompt. `PromptDecision.additionalContexts` and tool-result `additionalContexts` retain FIFO order and individual provenance, but no longer select placement. A waterfall listener that delegates with `next()` must preserve downstream prompt content and additional contexts unless it intentionally returns replacements.

Caller-driven injection and hook-produced additional context deliberately have different admission ownership. A hook's additional contexts materialize only after that hook allows the prompt or tool result. Outside a next-step acceptance window, a caller that invokes `inject(context)` and then `send(prompt)` commits context independently; callers requiring all-or-nothing behavior use a domain-specific admission wrapper.

Cross-session references use that domain composition: TUI prepares the snapshot, then either adds it to the prompt's admission decision outside an acceptance window or injects it beside steering during one. The target log contains two simple messages, so later source mutation cannot change replay and transcript consumers do not need a prompt envelope. This supersedes the attachment mechanism in the [cross-session reference decision](../feature/2026-07-21-cross-session-references.md) while retaining its snapshot and trust-boundary rules.

This decision preserves the caller-owned framing decision from [unwrapped injected content](../simplification/2026-07-20-unwrap-injected-content-envelopes.md) and the one-item turn rule from [one send, one turn](../simplification/2026-07-17-one-send-one-turn.md). The later [standalone log-only event decision](../simplification/2026-07-28-remove-synthetic-log-only-turns.md) applies the same execution-only meaning to plugin-owned records.

## Alternatives considered

**Keep `SendOptions.contexts` as an atomic attachment.** This preserves all-or-nothing delivery when prompt admission blocks, but it keeps context inside inbox lifecycle state and requires every queue transition and observation event to carry it. The generic agent API should not encode a domain transaction that most callers can express as context injection followed by message delivery.

**Keep a distinct `context/message` session event.** A separate event makes the out-of-turn exception narrower, but user-role model input would again have two event types with identical projection. `user/message.source` already carries the distinction needed by policy, transcript, and replay consumers.

**Keep one-shot turns for idle injection.** This retains universal turn enclosure and a convenient flush boundary, but it makes turn counts and turn observers report work that never ran the model. Durability is an independent session concern and can be awaited without fabricating execution.

**Keep `prompt-prefix` as an optional placement.** Prefix baking can make the context and request appear in one provider message, but it introduces a second representation of the direct prompt and spreads placement handling across admission, steering, logging, replay, and UI code. Producers that require textual framing may include it in their own context content.

**Let hooks call `inject()` directly instead of returning additional contexts.** Direct injection would erase the extension point's admission ownership: a listener could append context before a downstream listener blocks the operation. Returning `additionalContexts` keeps the waterfall result authoritative while sharing the same post-admission outbox path.

## Verification

- `SendOptions` and steering inbox records contain no attached contexts; `agent/inbox/enqueue` reports only the message plus its resolved queued-or-steering placement.
- `UserMessage` is the shared identified, frozen shape across prompt interception, tool execution, hook bridges, guards, and context producers.
- Prompt-prefix placement, prompt envelopes, and `context/message` are absent from public types, durable events, projection, and UI replay.
- Idle `inject()` appends one sourced `user/message` without a turn or model call.
- Admission-time and active-turn injection drain at safe boundaries after complete tool-result batches and before the request that consumes them.
- Blocked prompt admission opens no turn and appends neither the prompt nor hook-produced additional contexts; caller context alone falls back to an idle append, while a steering boundary remains available to retry.
- Unit, persistence/resume, invariant, host/client queue, and TUI coverage pin event order, admission ownership, and reconnect classification.

## Consequences

- One surface event is valid outside turns, so persistence scanning, crash repair, forking, compaction, and session queries distinguish execution enclosure from session history.
- Consecutive user-role messages replace one baked prompt message; provider adapters preserve that ordering.
- Outside an acceptance window, `inject()` followed by a blocked `send()` leaves context without its intended direct prompt unless the caller supplies domain-specific admission ownership.
- The public delivery contract and inbox records remain small: no context attachment, context-placement metadata, prompt envelope, or duplicate durable event type.
