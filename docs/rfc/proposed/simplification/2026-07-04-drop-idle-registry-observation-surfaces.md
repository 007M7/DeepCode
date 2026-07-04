# RFC: Drop idle registry and status observation surfaces

Status: proposed

## Problem

Several registry services expose "something changed" or "what is registered" observation surfaces with no production observer. The older [LLM adapter-change simplification](../../implemented/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.md) removed `llm/adapter-change` because it had declarations, emits, docs, and tests but no listener. The same pattern now exists in the remaining registry-change events: `tools/change`, `system-prompt/change`, and `web/providers-change`.

`tools/change` is declared by `dsh-tools` and emitted from `ToolRegistry.register()` on register and dispose ([packages/core/tools/src/index.ts](../../../../packages/core/tools/src/index.ts)). `system-prompt/change` is declared by `dsh-system-prompt` and emitted when sections or tool-schema providers register and dispose ([packages/core/system-prompt/src/index.ts](../../../../packages/core/system-prompt/src/index.ts)). `web/providers-change` is declared by `dsh-web` and emitted when search or fetch providers register and dispose ([packages/web/web/src/index.ts](../../../../packages/web/web/src/index.ts)). Grepping those event names outside `docs/rfc/**` finds declarations, emit sites, READMEs, generated catalogs, and tests, but no production listener in `packages/*/src` or examples.

Those events carry real complexity. Each registry yields a rollback disposer before emitting so a throwing change listener unwinds the just-added entry instead of leaking it into the registry. The packages then carry tests for listener-throw rollback paths that only the unused events can trigger. `web/providers-change` repeated the same pattern after the LLM adapter-change event was already proven unnecessary.

There is a related one-shot observation surface in `dsh-llm`: `ctx.llm.models()` returns registered model names, but no production caller uses it. Search finds only service docs and tests, including adapter tests that use it as a registration assertion. The shipped model-call path resolves by `options.model` at `ctx.llm.stream()` time; no UI, router, or product config enumerates model names from the service.

The same "status without observer" pattern now shows up in the web seam. `ctx.web.searchStatus()` and `ctx.web.fetchStatus()` are documented as diagnostics for `dsh-tool-web`, but the current tools execute directly through `ctx.web.search()` and `ctx.web.fetch()` ([packages/web/tool-web/src/search.ts](../../../../packages/web/tool-web/src/search.ts), [packages/web/tool-web/src/fetch.ts](../../../../packages/web/tool-web/src/fetch.ts)). The execution path already resolves the selected provider at call time and throws a structured `WebError` (`WEB_PROVIDER_UNAVAILABLE`, `WEB_PROVIDER_AMBIGUOUS`, `WEB_PROVIDER_CONFIGURED_MISSING`, `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`) when the capability cannot run. The status methods duplicate that selection logic for tests and stale docs, not for a live product surface.

## Proposal

Remove the idle registry-observation surfaces that have no production consumer:

- Delete `tools/change`, its emits, its JSDoc/README/generated-catalog entries, and listener-throw rollback tests.
- Delete `system-prompt/change`, its emits, its JSDoc/README/generated-catalog entries, and listener-throw rollback tests.
- Delete `web/providers-change`, its emits, its JSDoc/README/generated-catalog entries, and listener-throw rollback tests.
- Delete `LlmService.models()` and update LLM adapter/service tests to assert registration behavior through `stream()` resolution, duplicate-registration errors, disposal, or other behavior that a real caller observes.
- Delete `WebService.searchStatus()` / `fetchStatus()` and the `WebCapabilityStatus` contract if no other live type needs it. Web provider `status()` stays internal to provider resolution; callers observe availability by attempting `search()` / `fetch()` and handling `WebError`.

Registration should remain effect-scoped and HMR-safe: duplicate checks still happen before mutation, the disposer still removes the registered entry, and existing consumers still read the live registry at use time. What disappears is only the speculative observer surface.

## What stays

This RFC does not remove live query or execution surfaces. `ctx.tools.schemas()` stays because the system-prompt registry and generated tool catalog use it. `ctx.web.search()` and `ctx.web.fetch()` stay because they are the model-facing web tools' execution path and they already carry the provider-selection error taxonomy. `ctx.agents.list()`, `ctx.sessions.list()`, and `ctx.sessionPersistence.list()` stay because production code uses them for background-task ownership, invariant seeding, write coordination, and ACP load-cwd validation.

This RFC also does not touch live event seams such as `llm/stream`, `tools/execute`, `system-prompt/assemble`, `session/event`, `session/flush`, `agent/status`, or `fs/*`. Those have production listeners or are the documented extension points the architecture depends on.

## Why not keep them for a future UI?

A live tool palette, prompt-section inspector, web-provider status panel, or model picker might eventually want registry-change signals or status queries. But none exists today, and the current event payloads/status shapes are so minimal that a real UI would likely need to revisit them anyway. A future observer can reintroduce the smallest signal it actually consumes, with tests that prove the observer sees it.

The pre-release stance cuts in favor of narrowing now. A public event with no listener is still API surface; if it survives until release, every later cleanup has to decide whether external consumers might be relying on it.

## Acceptance criteria

- `rg "tools/change|system-prompt/change|web/providers-change" packages examples docs --glob '!docs/rfc/**'` finds no remaining declared event, emit, README row, generated-catalog entry, or test outside historical RFC text.
- `rg "ctx\\.llm\\.models\\(|\\.models\\(\\)" packages/llm packages/core/agent-loop examples docs --glob '!docs/rfc/**'` finds no remaining `LlmService.models()` API use or docs entry.
- `rg "searchStatus|fetchStatus|WebCapabilityStatus" packages/web docs --glob '!docs/rfc/**'` finds no remaining public web status surface, docs entry, generated-catalog entry, or tests except provider-private status concepts that still feed execution.
- Registration/disposal tests still prove HMR cleanup for tools, prompt sections/tool providers, web providers, and LLM adapters without depending on observer events.
- The [web capability seam RFC](../../implemented/architecture/2026-06-24-web-capability-seam.md), package READMEs, the Cordis catalog, and core data-structure docs are updated to remove the event and status promises.
- `pnpm run test:coverage`, `pnpm run doc-sync`, and `pnpm run hygiene` pass after implementation.

## Risks

- Removing emitted events is a public-surface change. The repo is unreleased, and the consumer audit says the current consumers are tests and docs only.
- Tests lose an easy way to assert that registration happened. They should assert behavior instead: a registered tool appears in `schemas()`, a registered prompt section appears in `assemble()`, a web provider can execute or throw the expected `WebError`, and an adapter can stream for its model.
- Web tests lose a cheap status assertion. They should assert the behavior a real caller observes: successful `search()` / `fetch()` for a usable provider and structured `WebError` codes for unavailable, ambiguous, or misconfigured provider sets.
- A future UI may need observer hooks or status queries. That is fine; the hook/query should return with that UI, not ahead of it.
