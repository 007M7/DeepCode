# Agent Note: Adapter-owned reasoning effort capabilities

Status: implemented

English | [中文](2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md)

## Problem

Reasoning strength was adapter configuration only, so a conversation could not discover or change the selected model's supported levels between requests. Promoting one adapter's level union into `dsh-llm` would make every provider and model adopt names it may not support, while a provider-specific options bag would make the loop unable to validate or durably reconstruct the effective request.

## Decision

`dsh-llm` represents a reasoning effort as the opaque branded `ReasoningEffortId`. An adapter's `resolveModelReasoning(provider, model)` returns a non-empty ordered list of ids with display metadata and may name one configured default. The core validates metadata, requires an explicit or configured effort to appear exactly in that list, and never clamps or aliases a value.

`LlmCallConfig` and `GenerateOptions` carry the optional effort. The agent loop resolves the post-`agent/request` config before writing `request/header`, so defaults and dynamic changes are model-visible only after becoming durable facts. A route with no registered adapter retains its proposed config so an `llm/stream` middleware can own and short-circuit it; terminal dispatch still rejects an unhandled route. A resumed loop retains the logged effort only when its initial provider/model route is unchanged; a route change discards the previous model's opaque id. The terminal `LlmService` adapter boundary repeats resolution for direct calls that do not pass through the loop.

The native DeepSeek adapter advertises `high` and `max`, defaults to configured effort or `high`, and exposes no effort capability while thinking is disabled. The pi-ai adapter derives each exact model's list from `getSupportedThinkingLevels()`, excludes `off`, preserves an absent profile default as a provider default, and leaves provider wire-value mapping inside pi-ai.

## Alternatives considered

**Define the pi-ai `ThinkingLevel` union in core.** Rejected because current pi-ai canonical names are an adapter implementation detail; a future provider can expose a different identifier without requiring a core release.

**Carry an untyped provider options object.** Rejected because the loop could neither validate a selected value nor put a stable provider-neutral fact in the request header.

**Clamp unsupported levels.** Rejected because a silent substitution makes the user's selected control differ from the logged request intent and hides stale deployment configuration.

**Include `off` as an effort.** Rejected because disabling reasoning is a mode capability with different request and output semantics, not a reasoning-strength level.

## Consequences

Clients can query one exact route and render the adapter's order and names without knowing a global enum. Adapter configuration remains the deployment-default owner, while `agent/request` can replace the effective effort on each step. Invalid metadata fails with `INVALID_MODEL_REASONING`, and unsupported explicit or configured values fail with `UNSUPPORTED_REASONING_EFFORT` before provider I/O.

The capability query is asynchronous and exact-model resolution may fail for adapters backed by authoritative catalogs. Keyless service, adapter, loop, session, and request-header tests pin validation, defaulting, dynamic changes, logging, and resume behavior; runnable snapshots pin the resolved effort in real assembled request headers, while key-gated adapter tests exercise provider serialization.
