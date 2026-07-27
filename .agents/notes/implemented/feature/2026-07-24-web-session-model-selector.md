# Agent Note: Session model selection in the Web composer

Status: implemented

English | [中文](2026-07-24-web-session-model-selector.zh.md)

## Problem

The Web conversation displayed and sent through the Host's fixed provider/model route without exposing that route or letting a user change it. The TUI already had a session-local route target, but copying its presentation or hardcoding DeepSeek models in the browser would split model discovery and step-boundary semantics across front doors. A switch made while a response is running also needs one atomic boundary: prompt variables and request routing cannot observe different targets.

## Decision

The Web Host reuses `installAgentLlmTarget` for every created or resumed agent. The target starts from the latest `request/header` when the session has used a model, otherwise from the Host default. `session.selectModel` changes the session-local mutable target, and prompt assembly captures it with request routing; a switch during a running step therefore applies to the next assembled step. The next consumed route persists through the existing full `request/header` snapshot, while a choice that has not reached a request remains process-local.

The session RPC domain exposes `session.history`'s current `modelTarget`, a `session.models` directory, and `session.selectModel`. The directory is built dynamically from the LLM registry and grouped by provider. Provider catalogs load concurrently and fail independently, so successful groups remain usable alongside retryable failure records. Catalog membership stays advisory: the current model is inserted as an unlisted row when its registered provider omits it, and selecting an unlisted model under a registered provider remains valid.

The browser `Session` object owns the current target, grouped catalog, provider failures, operation error, and `idle`/`loading`/`ready`/`selecting`/`error` state. A Host session primes the directory when its selector mounts so the compact trigger can resolve a catalog name, and each menu open refreshes it. The resident shell has no session model route before Workspace selection connects or reuses a Host session, so its disabled no-session input dispatches no selector. Directory and selection calls share an operation generation so older responses cannot replace a newer result; a separate target-change generation lets concurrent history restore the logged model across a mount-time directory refresh without allowing old history to overwrite a user selection. Failures retain the previous current target and usable groups.

`@deepseek-ai/dsh-client-ui-conversation` declares the session-scoped single slot `conversation.input.model` as a child of its composer-bar entry. InputBar renders the seat in its trailing controls immediately before the pending indicator and primary button; the seat receives the bar's `locked` owner prop and the session standard kit. `@deepseek-ai/dsh-client-ui-model-selector` occupies that dedicated seat, including for a Host-owned blank-session hero. Its compact trigger and radio rows display the catalog name, falling back to the model id for an unlisted current target, while the upward menu displays provider headings once with keyboard navigation, dismissal, retry states, and current selection marking.

The production browser roster is the flat config tree in `apps/cli/cordis.yml`; the selector is one `dshClient` row rather than a package hardcoded in Web boot code. Its package manifest still declares the graph edge on `ui-conversation`, while cordis service availability governs activation.

## Alternatives considered

**Use separate provider and model dropdowns.** The model list depends on the provider and repeats a two-stage interaction for every change. One grouped menu keeps the provider visible as organization without lengthening the trigger or each row.

**Hardcode the current DeepSeek catalog in the Web client.** This would drift from registered adapters and exclude deployment-owned providers. The LLM registry remains the source of provider and model metadata, including partial lookup failures.

**Make the selection a global default.** A global mutation would unexpectedly redirect other open conversations. The target belongs to one live session, while Host configuration remains the default for sessions without a logged request.

**Reject changes while an agent is running.** The shared atomic target already separates the assembled step from the next selection. Keeping the selector available lets the user prepare the following step without altering the in-flight request.

**Persist every click as a new session event.** A choice is not model-visible until prompt assembly consumes it. Persisting unused UI intent would add a durable event that does not reconstruct a model request; the existing `request/header` records the first request that actually uses the route.

## Consequences

Any Host-backed Web conversation, including a blank session, can switch among dynamically discovered provider groups without displaying duplicated `provider/model` labels, and the current used route survives resume and reconnect. Catalog names remain presentation-only; selection and persistence continue to use provider/model ids. A provider catalog outage degrades only that group. Selection changes can reduce provider-side cache reuse when the route changes, but the selector adds no prompt content and does not disturb the in-flight step. The resident shell uses the Host default and exposes no selector only while it has no current session.

## Testing

Host tests pin grouped discovery, duplicate-catalog isolation, partial provider failure, logged restoration, unlisted current targets, unavailable-provider rejection, and next-assembly switching. Client tests pin state transitions, failure preservation, transport errors, stale-response fencing, mount/open overlap, history restoration, and snapshot reference stability. UI tests pin the dedicated model-seat lifecycle and lock propagation, catalog-name labels with id fallback, provider grouping, radio semantics, retry/error states, successful and failed selection, outside dismissal, and Arrow/Home/End/Escape navigation. The keyless built-app fixture loads the selector through the production-shaped boot graph, selects OpenAI's GPT-5, sends a turn, and verifies that the next generated response reports the selected route.
