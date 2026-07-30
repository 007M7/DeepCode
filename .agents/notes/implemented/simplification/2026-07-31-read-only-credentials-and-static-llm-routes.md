# Agent Note: read-only credentials and static LLM routes

Status: implemented

English | [中文](2026-07-31-read-only-credentials-and-static-llm-routes.zh.md)

## Problem

The first request-level LLM configuration design shipped future configuration-UI capabilities before that UI existed. The credential seam exposed description, mutation, and change events; its local provider therefore needed a watcher, cache, operation queue, dotenv editor, writer lock, and a new shared atomic-write package. No production caller used those operations. Mutable adapter registrations and a dormant pi-ai mount similarly existed so settings could create routes even though provider ownership is a composition decision.

That speculative closure accounted for much of the feature's runtime and test growth, widened public contracts, and introduced lifecycle and concurrency failure modes unrelated to the two current consumers, which only need to resolve a named key for a request.

## Decision

`ctx.credentials` exposes only branded `CredentialRef` construction and `resolve(ref): Promise<string | undefined>`. `credentials-local` reads the named process environment value, then parses its dotenv file on demand. It owns no mutation, description, event, watcher, cache, editor, or writer lifecycle; externally changing either source is visible to the next resolution.

LLM provider routes and their retry policies are composition-owned. `registerAdapter()` returns a disposer rather than a mutable registration handle. DeepSeek always owns its one route, and pi-ai requires a non-empty configured route map; settings may change request-level facts for those existing routes but cannot create, remove, or retune registrations. The shared CLI composition therefore does not mount an empty pi-ai adapter.

The optional-settings helper only switches a consumer's source thunk between its composition entry and a live settings scope. Consumers read committed values through that thunk, so the helper needs no update watcher, derived-state callback, or teardown-state mirror. `settings-local` keeps its write protocol private instead of publishing a utility for a second writer that no longer exists.

## Alternatives considered

**Keep the credential writer for the planned web surface.** A future UI may need mutation and redacted description, but its exact RPC, ownership, and security contract is not shipped. Reintroducing the smallest closure with that consumer is cheaper than maintaining a generic write lifecycle meanwhile.

**Cache the dotenv file and watch for invalidation.** Per-resolution file I/O is small beside a model request and makes external rotation current without watcher readiness, debounce, missed-event, and disposal semantics.

**Keep mutable route registration as a generic registry feature.** Current adapters know their provider routes at composition. A mutable public handle creates a lifecycle state solely for a deferred settings-driven route feature.

**Keep a shared atomic-write package for settings alone.** One consumer does not justify a public package, peer dependency, invariant companion, and independent test surface; the settings provider owns its private write protocol.

## Consequences

Credential rotation remains restart-free when an operator or external secret manager changes the environment or dotenv document, but the harness offers no credential-management API or UI contract. pi-ai deployments explicitly compose at least one provider route. The remaining public seams match current production calls, and the removed watcher/editor/registration machinery no longer contributes concurrency or teardown states.

Focused seam, provider, dynamic-settings, Loader-composition, and missing-credential snapshot tests pin the smaller closure. The earlier [request-level configuration](../architecture/2026-07-29-request-level-llm-config-credentials.md) and [credential-boundary](../architecture/2026-07-30-credential-boundaries-and-atomic-registration.md) notes retain the motivation and surviving request/security decisions while deferring to this note for the removed mutation and route-lifecycle contracts.
