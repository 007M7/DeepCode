# Agent Note: Separate context injection from turn execution

Status: proposed

English | [中文](2026-07-24-separate-context-injection-from-turn-execution.zh.md)

## Problem

The agent API currently represents supplementary model-facing input in three overlapping ways: callers attach `HookContext[]` through `SendOptions.contexts`, interception and tool hooks return `additionalContexts`, and plugins call `agent.inject()`. These paths eventually write context into the same model history, but they carry different placement, metadata, admission, queue, and turn-lifecycle rules.

Atomic attachment to an inbox message forces the loop to preserve context through prompt admission, steering conversion, cancellation, and terminal discard. `prompt-prefix` placement then combines context and the direct prompt into one event, requiring a model-hidden envelope so transcript consumers can recover what the user actually wrote. The result makes outbox entries, session projection, and UI replay responsible for a distinction that belongs to the producer.

Idle `inject()` exposes a second mismatch. Injection does not request model execution, yet the current implementation opens and closes a zero-step `injection` turn solely to satisfy the turn-enclosure invariant and obtain a durability checkpoint. A turn therefore sometimes means “run the agent loop” and sometimes means “persist context without running it.”

`HookContext` also names its producer rather than its role. The value may come from a native plugin, a hook bridge, prompt admission, or tool post-processing. Its stable meaning is simply additional model-facing context with provenance.

## Proposal

Make `inject()` the only caller-facing operation for adding supplementary model-facing input, and define a turn exclusively as one execution of the model loop.

Remove `SendOptions.contexts`. A caller that owns context delivers it with `inject()` and independently submits the direct message with `send()` or `steer()`. Rename `HookContext` to `AdditionalContext`; retain only `content` and `source`, and remove placement and model-hidden metadata from this shared shape.

Prompt and tool extension points may still return `additionalContexts`. These values are outputs of the extension point, not attachments captured from a caller's inbox item. Prompt admission runs before `run()` opens a turn. An allowed prompt enters the outbox together with its returned additional contexts; a blocked prompt writes neither and opens no turn. Tool-produced additional contexts enter the same outbox after the corresponding tool results.

Every additional context becomes an independent `user/message` whose `source` records provenance. Remove `context/message`, prompt-prefix placement, the stable request delimiter, and the prompt envelope. Transcript and UI consumers distinguish direct user messages from injected context by `source`, not by recovering a hidden direct-prompt field from combined model content.

## Injection lifecycle

When a turn is open, `inject()` stages the context in the loop outbox. The loop drains the outbox at a safe step boundary, preserving tool protocol adjacency: a context accepted during an assistant tool-call batch appears only after that batch's complete ordered results. Taking the outbox as a whole makes steering and injected context accepted for one boundary visible to the same following request.

When no turn is open, `inject()` appends its `user/message` immediately and starts a session flush. It does not increment turn numbering, emit `turn/start` or `turn/end`, change agent status, or run the model. The synchronous API still returns before the asynchronous flush settles; `whenIdle()` and agent disposal include outstanding idle-injection flushes in their quiescence boundary.

A failed idle flush has no legitimate turn or step coordinates. It is reported through logging or a persistence-owned error surface, not by inventing an `agent/error` payload for a nonexistent turn. The in-memory event remains accepted and a later flush may retry persistence.

The session invariant therefore permits `user/message` between turns while continuing to require turn enclosure for execution events, steering, assistant output, tools, and package-added events by default. Persistence, recovery, resume, fork, and compaction code must treat a valid out-of-turn `user/message` as committed session history rather than an interrupted or discardable turn tail.

## Extension and caller semantics

`PromptDecision.content` continues to replace only the direct prompt. `PromptDecision.additionalContexts` and tool-result `additionalContexts` retain FIFO order and individual provenance, but no longer select placement. A waterfall listener that delegates with `next()` must preserve downstream prompt content and additional contexts unless it intentionally returns replacements.

Caller-driven injection and hook-produced additional context deliberately have different admission ownership. A hook's additional contexts materialize only after that hook allows the prompt or tool result. A caller that invokes `inject(context)` and then `send(prompt)` has already committed context independently; if prompt admission later blocks the prompt, the injected context remains in history. Callers requiring all-or-nothing domain behavior must perform their own preparation before either operation or expose a domain-specific admission seam.

Cross-session references follow the ordinary composition: the host prepares the snapshot, injects it with session-reference provenance, then sends or steers the readable direct prompt. The target log contains two simple messages, so later source mutation cannot change replay and transcript consumers do not need a prompt envelope. This supersedes the attachment mechanism in the [cross-session reference decision](../../implemented/feature/2026-07-21-cross-session-references.md) while retaining its snapshot and trust-boundary rules.

This proposal preserves the caller-owned framing decision from [unwrapped injected content](../../implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md), the one-item turn rule from [one send, one turn](../../implemented/simplification/2026-07-17-one-send-one-turn.md), and narrows the [turn-enclosure decision](../../implemented/architecture/2026-06-15-turn-enclosure-invariant.md) so turns enclose execution rather than every session event.

## Alternatives considered

**Keep `SendOptions.contexts` as an atomic attachment.** This preserves all-or-nothing delivery when prompt admission blocks, but it keeps context inside inbox lifecycle state and requires every queue transition and observation event to carry it. The generic agent API should not encode a domain transaction that most callers can express as context injection followed by message delivery.

**Keep a distinct `context/message` session event.** A separate event makes the out-of-turn exception narrower, but user-role model input would again have two event types with identical projection. `user/message.source` already carries the distinction needed by policy, transcript, and replay consumers.

**Keep one-shot turns for idle injection.** This retains universal turn enclosure and a convenient flush boundary, but it makes turn counts and turn observers report work that never ran the model. Durability is an independent session concern and can be awaited without fabricating execution.

**Keep `prompt-prefix` as an optional placement.** Prefix baking can make the context and request appear in one provider message, but it introduces a second representation of the direct prompt and spreads placement handling across admission, steering, logging, replay, and UI code. Producers that require textual framing may include it in their own context content.

**Let hooks call `inject()` directly instead of returning additional contexts.** Direct injection would erase the extension point's admission ownership: a listener could append context before a downstream listener blocks the operation. Returning `additionalContexts` keeps the waterfall result authoritative while sharing the same post-admission outbox path.

## Acceptance criteria

- `SendOptions` and steering inbox records contain no attached contexts; `agent/queued` reports only the retained message and steering facts.
- `AdditionalContext` replaces `HookContext` across prompt interception, tool execution, hook bridges, guards, and context producers, with only `content` and `source`.
- Prompt-prefix placement, prompt envelopes, and `context/message` are absent from public types, durable events, projection, and UI replay.
- Idle `inject()` appends and flushes one sourced `user/message` without a turn or model call; `whenIdle()` and disposal await the flush.
- Active-turn injection and hook-produced contexts drain at safe boundaries after complete tool-result batches and before the request that consumes them.
- Blocked prompt admission opens no turn and appends neither the prompt nor hook-produced additional contexts; independently injected caller context remains.
- Unit, persistence/resume, invariant, ACP/TUI replay, and keyless assembled-application snapshots cover the new event order and durability semantics.

## Risks

- Allowing one surface event outside turns weakens a simple invariant and may expose hidden assumptions in persistence scanning, crash repair, forking, compaction, and session queries.
- Consecutive user-role messages replace one baked prompt message; provider adapters and cache behavior must accept and preserve that ordering.
- `inject()` followed by a blocked `send()` leaves context without its intended direct prompt unless the caller accepts the independent-commit contract.
- A synchronous injection API cannot return flush failure. Logging alone is less structured than `agent/error`, while adding a new persistence event solely for this case may create another unnecessary seam.
- Removing attachment, placement, metadata, envelopes, and a durable event type is a broad pre-release migration that must update every producer and consumer atomically.
