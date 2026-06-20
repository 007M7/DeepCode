# RFC: Treat unstable LLM APIs as a first-class failure mode

Status: proposed

## Problem

LLM APIs are not a stable local function call. They rate-limit, overload, return 5xx/502/503 from gateways, close streaming sockets before `[DONE]`, emit malformed or provider-specific error payloads, hang mid-stream, surface SDK errors as in-band events, and sometimes require a delayed retry using `Retry-After`. The harness currently contains good error containment, but it does not yet treat this API instability as a first-class design problem.

`dsh-llm` defines two sanctioned adapter failure paths - throw from `stream()` or end with `finish { kind: 'error' | 'aborted' }` - and the agent loop translates both into a failed step instead of logging a fake completed assistant message. That was the right MVP containment baseline, documented in [the architecture](../../../architecture.md) and reinforced by [the twin-adapter RFC](../../implemented/architecture/2026-06-13-twin-llm-adapters.md). It is not enough for an agent that depends on an unstable remote model API for every turn.

The audit found four load-bearing gaps.

- `LlmError` and `FinishReasonMap.error` carry only `message`, `code`, and sometimes HTTP `status` ([packages/llm/llm/src/index.ts](../../../../packages/llm/llm/src/index.ts), [packages/llm/llm/src/types.ts](../../../../packages/llm/llm/src/types.ts)). A caller cannot reliably tell "retry this after 800 ms on the same endpoint", "fail over to another route for the same model", "ask the user for credentials", "never retry because the request is invalid", "provider truncated the stream after committed output", or "adapter protocol bug" without provider-specific heuristics.
- The `llm/stream` waterfall is documented as the place for retry/routing/caching, but its value is one committed `AsyncIterable<StreamChunk>`. A listener can technically catch an API error and call `next()` again, but once it has yielded any chunks to the agent loop those chunks are already appended as `assistant/chunk` events and emitted to UI. Retrying after that point would concatenate chunks from two provider attempts into one model step, corrupting replay and the user transcript.
- The adapter registry is one adapter per model name. That makes "logical model" and "concrete API route" the same thing, so the service has no vocabulary for "same model through another endpoint or SDK", "same provider region with different health", "fallback route with compatible capabilities", provider request ids, or per-route backoff state.
- Crash recovery and LLM API recovery are easy to conflate. `dsh-session` repairs an interrupted durable log by closing an open turn and synthesizing missing tool results ([packages/core/session/src/repair.ts](../../../../packages/core/session/src/repair.ts)); that preserves already-written work after a process crash. It does not make a failed provider attempt safe to retry, discard, replay, or fail over.

The result is a system that can survive an unstable LLM API without killing the loop, but cannot make principled recovery decisions. For a coding agent, that is underdesigned: ordinary provider turbulence should not require every UI or product plugin to reinvent retries around an unsafe stream boundary.

## Proposal

Introduce an LLM-call v2 contract centered on API-instability recovery: classify provider/API failures, separate provider attempts from committed model output, route logical models through recoverable API routes, and make conservative retry/failover the default behavior in `dsh-llm`. Because the harness is unreleased, this should be a breaking cleanup rather than a compatibility layer around the underspecified v1 surface.

### 1. Replace flat error codes with a serializable `LlmFailure`

Keep `HarnessError` as the common thrown-error base, but make LLM failures carry a structured, JSON-serializable payload. `code` remains a stable leaf label for logs and provider-specific matching; retry/failover policy branches on the structured fields.

```ts ignore-check
type LlmFailureClass =
  | 'auth'
  | 'rate-limit'
  | 'quota'
  | 'invalid-request'
  | 'unsupported'
  | 'timeout'
  | 'transport'
  | 'provider-overloaded'
  | 'provider-unavailable'
  | 'provider-bug'
  | 'protocol'
  | 'safety'
  | 'aborted'
  | 'unknown'

type LlmFailurePhase =
  | 'request-build'
  | 'connect'
  | 'response-headers'
  | 'stream'
  | 'finish'

interface LlmFailure {
  message: string
  code: string
  class: LlmFailureClass
  phase: LlmFailurePhase
  retryable: boolean
  failover: 'never' | 'same-model' | 'compatible-model'
  partialOutput: 'none' | 'uncommitted' | 'committed'
  provider?: string
  routeId?: string
  model?: string
  wireModel?: string
  status?: number
  retryAfterMs?: number
  requestId?: string
}
```

`LlmError` should carry `failure: LlmFailure`; `FinishReasonMap.error` should carry the same payload instead of a parallel `{ message, code? }` shape. The agent loop should persist the serializable failure fields in `session error` and `turn/end { kind: 'error' }`, while the thrown `LlmError` may still carry a non-serializable `cause` chain for local debugging.

Adapters are responsible for faithful provider/API classification at their boundary: HTTP status, `Retry-After`, provider request id headers, SDK error type, timeout vs caller abort, malformed SSE, missing `[DONE]`, unknown finish reason, and unsupported local request shape. The current pi-ai adapter's regex over message text is acceptable only as a temporary fallback when the SDK hides the real status; the adapter should prefer structured SDK/provider fields when available.

### 2. Split provider attempts from committed model output

Make "attempt" a first-class boundary below `ctx.llm.stream()`. An adapter streams one provider API attempt. The LLM service runs zero or more attempts according to recovery policy and yields only committed output to the agent loop.

The important invariant: chunks from a failed attempt must never be silently spliced together with chunks from a later attempt as one assistant step. Recovery must choose one of these paths instead:

- **Retry before commit.** If an API attempt fails before any chunks are committed to the loop, the service may retry or fail over and hide the failed attempt from `assistant/chunk` history, while recording attempt diagnostics separately.
- **Commit and stop retrying.** Once chunks are committed to the loop, the attempt owns the visible step. If it later fails, the step fails with `partialOutput: 'committed'`; automatic retry is not allowed unless a later RFC designs an explicit continuation/repair protocol.
- **Buffered recovery mode.** A caller or policy may choose to buffer an entire attempt until it reaches `finish`, then yield the winning attempt's chunks. This improves retryability against flaky APIs at the cost of live token streaming and should be a deliberate mode, not an accidental side effect.

This likely means replacing the single overloaded `llm/stream` waterfall with narrower hooks: one around a single provider attempt, one around recovery policy decisions, and one around the committed stream. Names are implementation details for the follow-up PR, but the semantics are not: plugins must be able to wrap "one API attempt" without pretending they can safely retry already-committed chunks.

### 3. Route logical models through recoverable API routes

Separate the logical model a caller requests from the concrete provider route that serves an attempt. Replace "one adapter per model name" with route registration, for example:

```ts ignore-check
ctx.llm.registerRoute({
  routeId: 'deepseek-direct:deepseek-v4-flash',
  model: 'deepseek-v4-flash',
  wireModel: 'deepseek-v4-flash',
  provider: 'deepseek',
  adapter,
  priority: 0,
  capabilities: { tools: true, reasoning: true, images: false, prefill: false },
})
```

`GenerateOptions.model` remains the logical model. The service resolves it to a route for each API attempt, records the route in failure/attempt diagnostics, and can retry on the same route or fail over to another route with compatible capabilities. Duplicate model names become normal; duplicate route ids are the conflict. This is the smallest vocabulary that can express direct endpoint vs SDK-backed endpoint, regional endpoints, and future fallback models without making every caller own routing.

### 4. Put default API recovery policy in `dsh-llm`

Adapters should not perform hidden SDK retries unless those retries are surfaced as attempts with classified failures. The service owns the default policy so every consumer gets the same behavior and the same audit trail.

Default policy should be conservative:

- Retry transient API failures (`rate-limit`, `timeout`, `transport`, `provider-overloaded`, `provider-unavailable`) only before committed output.
- Honor `retryAfterMs`, otherwise use bounded exponential backoff with jitter.
- Treat 429/408/409/425/500/502/503/504 and connection resets as potentially recoverable unless the provider payload says otherwise; treat 400/401/403, unsupported local options, caller abort, and adapter protocol bugs as non-retryable.
- Fail over only when the failure says failover is safe and the candidate route advertises compatible capabilities for the request (`tools`, reasoning passback, images, prefill, stop sequences, strict tools).
- Share the caller's `AbortSignal` across the whole recovered call, and expose per-attempt timeouts as explicit policy. A stuck stream must time out in a controlled way instead of hanging the turn forever.
- Bound attempts by count and elapsed time, with clear failure reporting when the budget is exhausted.

The policy should be configurable through a typed service option and an event/waterfall seam so product plugins can tighten or loosen it, but the default must be safe enough that a basic agent does not need a custom retry plugin to survive ordinary 429/5xx/connectivity noise.

### 5. Record API attempt diagnostics without polluting derived history

The session log should be able to explain what happened during a recovered model call without feeding failed attempts back to the model as assistant output. Add turn-enclosed, derive-skipped diagnostics for LLM API attempts, or an equivalent trace surface if we decide session events should stay conversation-only. The data must be JSON-serializable and include attempt number, route id, failure payload, backoff, provider request id, and whether any chunks were committed.

`assistant/chunk` remains the replay source for the committed attempt only. Hidden failed attempts are diagnostics, not model history. A stream that fails after committed chunks remains replayable as a thrown stream through the existing `llm-replay` sidecar mechanism, but the failure payload should become structured rather than `{ message, code, status? }`.

## Out of scope

This RFC does not propose silent mid-stream continuation after user-visible output. That requires a separate model-history design: either provider-supported prefill/continuation, a recovery prompt that explicitly shows the partial assistant output, or a UI affordance that marks the partial answer as failed and asks the model to continue in a new step. Splicing two API attempts into one assistant message is rejected.

This RFC also does not solve semantic model-output repair: malformed tool-call JSON, refusal handling, or content-filter fallbacks. Those may use the same failure vocabulary later, but they are higher-level agent behaviors, not unstable-API recovery.

## Acceptance criteria

- `LlmError` and in-band finish errors carry one structured `LlmFailure` payload; the agent loop persists that payload's serializable fields in error turn data.
- Recovery policy can distinguish retry, failover, credential/user-action, unsupported request, caller abort, adapter/protocol bug, and post-commit partial stream failure without parsing message text.
- The LLM service has an explicit API-attempt boundary; no retry path can append chunks from two provider attempts as one committed assistant step.
- The route registry allows multiple concrete API routes for one logical model and records the selected route on attempts/failures.
- Default recovery retries transient pre-commit failures with bounded backoff, honors provider retry-after hints, times out stuck streams, disables hidden SDK retries or surfaces them as attempts, and never retries after committed chunks without an explicit continuation design.
- Unit tests cover thrown errors and finish-error chunks through the real agent loop, retry-before-first-chunk, failover to a second compatible route, retry budget exhaustion, abort during backoff, stream timeout, and the "partial chunks then failure does not retry/splice" invariant.
- Adapter tests classify representative HTTP statuses, retry-after headers, request ids, malformed/truncated SSE streams, SDK in-stream errors, caller aborts, and unsupported options into `LlmFailure`.
- Snapshot/replay support can faithfully represent a recovered call and a post-commit thrown stream without losing the structured failure payload.
- Docs updated in the same change: [the architecture LLM section](../../../architecture.md), [the LLM adapter cookbook](../../../cookbook/adding-an-llm-adapter.md), and the LLM package READMEs.

## Risks / what we give up

- **More surface area in the LLM core.** API recovery adds policy, route state, attempt diagnostics, and tests. That complexity belongs in `dsh-llm` because every consumer otherwise reinvents it around the same unsafe stream boundary.
- **Some modes reduce live streaming.** Buffered recovery trades first-token latency for safe retry. That should be opt-in or policy-driven; the default can still stream eagerly while retrying only before commit.
- **Breaking adapter churn.** Existing adapters will change from "stream chunks or throw a flat `LlmError`" to "stream one classified API attempt." Pre-release rules favor the correct seam over shims.
- **Route compatibility is easy to overclaim.** A route must advertise concrete capabilities, and failover must check the request actually fits them. "Same model name" is not enough when one route lacks strict tools, reasoning passback, images, stop sequences, or prefill.

## Related

- Builds on [Provider-neutral content-block vocabulary](../../implemented/architecture/2026-06-11-content-block-vocabulary.md): the content vocabulary stays provider-neutral; this adds a provider-neutral failure/recovery vocabulary beside it.
- Revises the scope implied by [Two LLM adapters as a design-verification twin](../../implemented/architecture/2026-06-13-twin-llm-adapters.md): the twin validated chunk shape and error delivery paths, but it also exposed that delivery paths are not enough for unstable API recovery.
- Extends [Structured error taxonomy](../../implemented/architecture/2026-06-11-structured-error-taxonomy.md): `HarnessError.code` was the foundation; LLM API recovery needs a richer payload because retry/failover policy cannot safely branch on one flat string.
