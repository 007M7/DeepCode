# Agent Note: Session model selection in the Web composer

Status: implemented

English | [中文](2026-07-24-web-session-model-selector.zh.md)

## Problem

The Web conversation displayed and sent through the Host's fixed provider/model route without exposing that route or letting a user change it. The TUI already had a session-local route target, but copying its presentation or hardcoding DeepSeek models in the browser would split model discovery and step-boundary semantics across front doors. A switch made while a response is running also needs one atomic boundary: prompt variables and request routing cannot observe different targets.

## Decision

The Web Host reuses `installAgentLlmTarget` for every created or resumed agent. The target starts from the latest `request/header` when the session has used a model, otherwise from the Host default. `session.selectModel` changes the session-local mutable target, and prompt assembly captures it with request routing; a switch during a running step therefore applies to the next assembled step. The next consumed route persists through the existing full `request/header` snapshot, while a choice that has not reached a request remains process-local.

The session RPC domain exposes `session.history`'s current `modelTarget`, a `session.models` directory, and `session.selectModel`. The directory is built dynamically from the LLM registry and grouped by provider. Provider catalogs load concurrently and fail independently, so successful groups remain usable alongside retryable failure records. Catalog membership stays advisory: the current model is inserted as an unlisted row when its registered provider omits it, and selecting an unlisted model under a registered provider remains valid.

The browser `Session` object owns the current target, grouped catalog, provider failures, operation error, and `idle`/`loading`/`ready`/`selecting`/`error` state. Selector mount primes the directory so the compact trigger can resolve a catalog name, and each menu open refreshes it. Directory and selection calls share a generation counter so older responses cannot replace a newer result; failures retain the previous current target and usable groups.

`@deepseek-ai/dsh-client-ui-conversation` declares the session-scoped single slot `conversation.composer.control` immediately before its primary button. `@deepseek-ai/dsh-client-ui-model-selector` occupies that slot only in an existing conversation. Its compact trigger and radio rows display the catalog name, falling back to the model id for an unlisted current target, while the upward menu displays provider headings once with keyboard navigation, dismissal, retry states, and current selection marking.

## Alternatives considered

**Use separate provider and model dropdowns.** The model list depends on the provider and repeats a two-stage interaction for every change. One grouped menu keeps the provider visible as organization without lengthening the trigger or each row.

**Hardcode the current DeepSeek catalog in the Web client.** This would drift from registered adapters and exclude deployment-owned providers. The LLM registry remains the source of provider and model metadata, including partial lookup failures.

**Make the selection a global default.** A global mutation would unexpectedly redirect other open conversations. The target belongs to one live session, while Host configuration remains the default for sessions without a logged request.

**Reject changes while an agent is running.** The shared atomic target already separates the assembled step from the next selection. Keeping the selector available lets the user prepare the following step without altering the in-flight request.

**Persist every click as a new session event.** A choice is not model-visible until prompt assembly consumes it. Persisting unused UI intent would add a durable event that does not reconstruct a model request; the existing `request/header` records the first request that actually uses the route.

## Consequences

An existing Web conversation can switch among dynamically discovered provider groups without displaying duplicated `provider/model` labels, and the current used route survives resume and reconnect. Catalog names remain presentation-only; selection and persistence continue to use provider/model ids. A provider catalog outage degrades only that group. Selection changes can reduce provider-side cache reuse when the route changes, but the selector adds no prompt content and does not disturb the in-flight step. The empty new-session composer still uses the Host default because it has no session identity or selector slot.

## Testing

Host tests pin grouped discovery, duplicate-catalog isolation, partial provider failure, logged restoration, unlisted current targets, unavailable-provider rejection, and next-assembly switching. Client tests pin state transitions, failure preservation, transport errors, stale-response fencing, history restoration, and snapshot reference stability. UI tests pin slot lifecycle, catalog-name labels with id fallback, provider grouping, radio semantics, retry/error states, successful and failed selection, outside dismissal, and Arrow/Home/End/Escape navigation. The keyless Web fixture exposes two provider groups and reports the selected route in the next generated response.
