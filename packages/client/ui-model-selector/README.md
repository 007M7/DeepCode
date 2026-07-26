# @deepseek-ai/dsh-client-ui-model-selector

Session-scoped Web model selector. Its browser half occupies `conversation.composer.control`, shows the current catalog name beside the send button, and opens an upward provider-grouped menu. Provider names appear once as group headings; model rows and the trigger show catalog names without repeating the provider route, with the model id as the fallback for an unlisted current target.

The selector primes the advisory directory when an existing Host session mounts so the trigger can resolve the catalog name, then refreshes it whenever the menu opens. A frontend Session Intent has no Host model route yet, so the selector stays absent and issues no directory RPC until publication clears the intent. The Session object layer owns loading, selection, partial-provider-failure, and stale-response state. A selection updates only that live session and takes effect at the next prompt-assembly boundary, including while the current step is running. The latest consumed target remains durable through the existing `request/header`; an unused choice is process-local.

Catalog membership is not request validation. The current target is included as an unlisted row when its registered provider omits it, while a target whose provider is unavailable remains visible on the trigger with a warning in the menu.

## Model Experience

None, as the browser selector changes subsequent request routing but adds no model-visible content.

#### KV Cache effect

Switching routes may invalidate provider-side cache reuse according to the selected adapter. The selector itself adds no prompt content.

## Known Limitations and Deferred Work

- **The new-session composer has no selector** — a session starts with the host default and exposes the selector after creation.
- **Unused selections are not durable** — reload restores the last route consumed by a request, not a choice made without sending.
