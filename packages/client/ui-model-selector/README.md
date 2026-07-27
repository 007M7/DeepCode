# @deepseek-ai/dsh-client-ui-model-selector

English | [中文](README.zh.md)

Session-scoped Web model selector. Its browser half occupies `conversation.input.model`, shows the current catalog name beside the send button, and opens an upward provider-grouped menu. Provider names appear once as group headings; model rows and the trigger show catalog names without repeating the provider route, with the model id as the fallback for an unlisted current target.

The selector primes the advisory directory when a Host session's composer mounts so the trigger can resolve the catalog name, then refreshes it whenever the menu opens. The resident no-session shell uses a disabled input bar and has no session-scoped model seat. The Session object layer owns loading, selection, partial-provider-failure, and stale-response state. A selection updates only that live session and takes effect at the next prompt-assembly boundary, including while the current step is running. The latest consumed target remains durable through the existing `request/header`; an unused choice is process-local.

Catalog membership is not request validation. The current target is included as an unlisted row when its registered provider omits it, while a target whose provider is unavailable remains visible on the trigger with a warning in the menu.

## Model Experience

None, as the browser selector changes subsequent request routing but adds no model-visible content.

#### KV Cache effect

Switching routes may invalidate provider-side cache reuse according to the selected adapter. The selector itself adds no prompt content.

## Known Limitations and Deferred Work

- **The no-session shell has no selector** — the control appears after Workspace selection connects or reuses a Host session, including a blank session.
- **Unused selections are not durable** — reload restores the last route consumed by a request, not a choice made without sending.
