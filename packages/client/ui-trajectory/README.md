# @deepseek-ai/dsh-client-ui-trajectory

English | [中文](README.zh.md)

Trajectory renders a turn-aware event ledger with selectable User, Assistant, Tool, and nested Subtool records. Thick rules mark Turn boundaries, compact inline markers identify Steps, and the main ledger keeps only index, event, and content; selection opens a local inspector for token usage, duration, Input, Output, and Timing. The package also provides the Waterfall view and remains a pure-consumer plugin (registers two view tabs into the conversation's `'conversation.view'` slot ring, provides no service, declares no Context merge). Contract: api-contracts v3 §8.

## Model Experience

None, as the trajectory views render session data in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **In-flight Time stays blank** — `partial` / `runningCalls` rows show their running state without a fabricated duration until a live clock policy lands; record selection is intentionally local to Trajectory; anchor deep-linking remains deferred.
