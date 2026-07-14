# RFC: Optional time-context plugin

Status: implemented

English | [中文](2026-07-14-time-context-plugin.zh.md)

## Problem

An agent request has no live clock unless a deployment hard-codes one into prompt text or gives the model a tool to query it. Static text becomes false immediately, while a tool call is unnecessary overhead for ordinary reasoning about dates, deadlines, or how long a conversation has been idle. The missing companion fact is elapsed time: the model receives the current user prompt but cannot distinguish a quick follow-up from one sent hours after the preceding conversation message.

The prompt assembly and session log already provide the necessary inputs. A section provider runs once per step with the active agent, model-visible session events carry durable append timestamps, and the request-header fold records the exact rendered system prompt. The design question is where temporal facts belong and how often they change without accumulating stale readings or creating background work.

## Decision

`@deepseek-ai/dsh-time-context` is an optional function plugin at `packages/context/time-context/`. It opens the `context/` product group for bounded request-context enrichments that define neither a tool nor a service seam. The package is not loaded by `dsh-agent-core` or a shipped example; a deployment mounts it explicitly when temporal context is worth the tokens and disclosure.

The plugin registers one global `ctx.systemPrompt.section()` contribution named `context:time` at order 10, after the deployment persona and before tool guidance. Its provider returns two lines for an active agent turn: an ISO-shaped timestamp with numeric UTC offset and IANA zone, and a compact whole-second duration since the last model-visible message before that turn opened. A bare or idle prompt assembly receives an empty section.

### Previous-message baseline

At a turn's first assembly, the provider scans backward from that turn's `turn/start` and uses the latest `user/message`, `assistant/message`, `tool/result`, `context/message`, or `steering/message` timestamp. It deliberately excludes the current turn's newly appended user prompt: measuring from that event would make the first request report approximately zero and lose the inter-turn gap the feature exists to convey. Every later refresh in the same turn retains the baseline, so a long-running turn reports the growing duration since the preceding conversation message. The first turn reports `unavailable (no earlier message in this session)`.

The baseline is the session event's append time, not an unlogged client receipt time. That makes resume and fork behavior deterministic from the durable log and keeps the model-visible value reconstructable without introducing a new event. A backward wall-clock adjustment clamps the displayed duration to zero rather than producing a negative interval.

### Refresh policy

`refreshIntervalMs` defaults to 60,000 and must be a non-negative safe integer. Every turn's first request refreshes regardless of the prior turn's timestamp. Within a multi-step turn, a later assembly reuses the cached block until its age reaches the interval; `0` refreshes every step. The policy is request-bound: no timer creates work while the agent is inside a model call, running a tool, or idle, because no request exists to consume a new value.

`timeZone` defaults to `UTC` and is validated as an IANA identifier at plugin load. The formatter emits an ISO-shaped local timestamp including the resolved zone and its current numeric offset, so daylight-saving changes remain explicit instead of silently shifting a zone-less clock.

### Logging and token shape

The temporal block is dynamic system-prompt state. The loop's existing `request/header` snapshot and `request/header-delta` fold records every rendered change before transmission, satisfying the [reconstructable-requests contract](../architecture/2026-07-05-reconstructable-requests.md). A request carries exactly one current block; previous readings do not remain in derived conversation history. This follows the ownership rule in the [prompt-variables RFC](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md): the optional plugin owns the temporal fact and contributes it through the ordinary prompt registry, with no loop special case.

## Testing

The package suite uses fake system time and covers UTC and offset formatting, first-turn fallback, every eligible previous-message variant, whole-duration units, backward-clock clamping, per-turn refresh, interval reuse, interval expiry, `0` per-step behavior, independent per-agent caches, invalid config, HMR disposal, and the Loader namespace path. A real agent-loop test pins the transmitted system prompt and its `request/header-delta` refresh record. No default snapshot changes because the plugin is intentionally absent from every shipped composition; mounting it in a default snapshot fixture would violate the opt-in decision.

## Alternatives considered

- **Append a `context/message` on every turn or refresh** — rejected: each reading remains in derived history, so stale clock values and token cost accumulate with conversation length. A surface replacement cannot both remove the old node and move the new reading to the tail; replacement preserves the old node's position, while replacing through the tail would hide intervening conversation.
- **Use `agent/session-prefix`** — rejected: the prefix is composed once per loop instance and is intentionally session-stable, so it cannot represent a clock that changes per turn or step.
- **Mutate requests in `agent/request`** — rejected: that seam shapes call config only, fires after the message boundary, and model-visible content inserted there would bypass both prompt-pressure accounting and the logged-header contract.
- **Register separate `{{current_time}}` and `{{elapsed}}` prompt variables** — rejected: independent providers can sample different instants and need shared caching to keep refresh semantics atomic. One section provider computes and records the pair as one value; deployments do not need to repeat a temporal template in their persona.
- **Inject from a background timer at the configured interval** — rejected: while no model request is being assembled, a fresh value has no consumer. Timer-driven `agent.inject()` would create durable one-shot turns and wake or mutate idle sessions merely to announce time passing.
- **Mount the plugin in `dsh-agent-core`** — rejected: time zone, disclosure, token budget, and desired freshness are deployment policy. Explicit opt-in keeps the default harness context stable.
- **Place the package in `core/`** — rejected: core owns the product API spine. A context enrichment is an optional leaf with no service key, so the dedicated group states its composition role directly.

## Consequences

- Models in opted-in deployments receive an unambiguous zoned clock and an inter-turn elapsed duration without spending a tool call. The system-prompt token cost is fixed per request instead of growing with the session.
- A refresh changes the request header and therefore adds a `request/header-delta` event. `refreshIntervalMs` trades clock freshness against those durable deltas; setting it to zero intentionally records a new value on every step whose whole-second rendering changed.
- No request is created solely to refresh time. A tool that runs longer than the interval leaves the prior reading in place until the next step assembles, when the provider catches up.
- The duration reflects harness processing time at durable append boundaries, not client-network latency before the message entered the log. Preserving a client-origin timestamp would require a separate durable input contract and is outside this plugin.
