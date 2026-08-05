# @deepseek-ai/dsh-client-ui-schedule

English | [中文](README.zh.md)

Browser-only renderer for durable Schedule reminder receipts. The plugin registers the durable `schedule/change` event type in the conversation-owned `conversation.chat.eventview` slot. The generic runtime continues to carry the durable event identity and its Host-computed JSON sidecar; this package owns only the Schedule card.

The card displays the reminder prompt, Session-local Schedule ID, exact UTC occurrence, and the `session-local` delivery boundary. A malformed or incompatible sidecar remains visible as a contained unavailable receipt instead of crashing the conversation. Unloading the plugin removes only the keyed renderer; `ui-conversation` then shows its generic visible JSON fallback for the same durable event.

## Model Experience

None, as this browser-only renderer registers no model surface; Schedule tools and reminder framing belong to `@deepseek-ai/dsh-tool-schedule`.

#### KV Cache effect

None. The renderer consumes a browser-side presentation sidecar after the durable event is committed.

## Known Limitations and Deferred Work

- **Receipt-only UI** — creating, listing, and deleting reminders remains model-driven through the Schedule tools; this package does not add a management page.
- **Session-local delivery** — the card records a receipt in the original Session. It does not imply a system, browser, email, or other external notification.
