# Agent Note: Intent-named subagent continuation operations

Status: implemented

English | [中文](2026-07-27-intent-named-subagent-continuation-operations.zh.md)

The `followup` operation this record names is retained by [Continuable subagents](../feature/2026-07-28-continuable-subagent-conversations.md), which replaces its Task-backed return value with the accepted `MessageId`, retains its bare `Agent` parameter as exact live-direct-parent authority, and replaces provider `resume` dispatch with `prepareContinuable`.

## Problem

Merging continuable-child orchestration into `ctx.subagents` left provider dispatch and caller intent on the same public service. `resume(name, request)` accepted a descriptor, authorized parent, durable child id, and activation signal that only the internal continuation manager could resolve correctly. `sendMessage(...)` exposed transport wording rather than the `followup` intent already used by `Agent`, and its separate source and signal parameters widened an operation every caller had to use atomically.

The durability boundary also exposed both `SessionStore.flush()` and `flushRequired()`. They performed the same scoped parallel dispatch and differed only in whether an empty listener snapshot was accepted, so the session interface encoded one consumer's policy as a second operation.

## Decision

`SubagentService` exposes three execution intents: `start(name, request)` for an ordinary holder-owned run, `startContinuable(spec)` for a durable Task-backed child, and `followup(parent, childId, content, { source, signal })` for later content. The last verb matches `Agent.followup()`, while `SubagentRun.steer()` remains the narrower confirmed live-activation capability. The model-facing tool keeps its stable `send_message` name and delegates routing to `followup()`.

Caller and provider requests are distinct. `SubagentStartRequest` contains only caller-supplied start data; `SubagentProviderStartRequest` adds service-resolved continuation state. Ordinary `start()` clears that state before provider dispatch. `SubagentProviderResumeRequest` remains part of the provider seam, but `SubagentService.resume()` is absent: the continuation manager loads the descriptor, authorizes the parent, and invokes private provider start/resume closures owned by the service. Provider dispatch still receives the same capability checks and run lifecycle observation without becoming a caller operation.

`SessionStore.flush(session)` returns `Promise<boolean>`. It resolves `true` after at least one scoped durability listener participates successfully, resolves `false` for an empty listener snapshot, and rejects with the first registered listener failure after all listeners settle. Ordinary checkpoints may ignore the boolean. A continuable provider requires `true` at its final result boundary and maps `false` or rejection to `DURABILITY_FAILED`.

## Alternatives considered

**Keep public provider resume dispatch.** No production caller outside the continuation manager owns the descriptor lookup, direct-parent authorization, Task cancellation, and activation association needed to call it safely. A public method would expose resolved implementation data without a valid independent intent.

**Keep `sendMessage` on the service.** The model tool sends a message, but the service operation represents a follow-up that may steer or cold-resume. `followup` aligns with the structural `Agent` interface and does not promise a particular route.

**Keep `flushRequired()`.** A second method hides only an empty-listener check. Returning participation from the existing barrier keeps dispatch in one implementation and lets each caller state whether absence is acceptable.

**Fold ordinary and continuable starts together.** A flag would make one method return either an awaited holder-owned run or immediate child/Task identities. Separate intent methods preserve the ownership and timing distinction without a return union.

## Consequences

- The Cordis service catalog contains only caller operations; provider reconstruction remains extensible through `SubagentProvider.resume?()` without exposing its resolved request as a service method.
- Follow-up source and cancellation travel in one options object, matching the intent-helper shape on `Agent` while retaining the existing live-delivery and cold-resume semantics.
- Session durability has one barrier operation. Callers that require a backend must inspect its participation result rather than selecting a second dispatch method.
- The `send_message` schema, route results, Task ownership, durable event vocabulary, and model-visible transcript remain unchanged.
