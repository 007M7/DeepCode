# @deepseek-ai/dsh-client-ui-trajectory

English | [中文](README.zh.md)

Trajectory turn-list chrome (sticky Turn / Message·Step groups / step cells) plus Waterfall placeholder; the pure-consumer minimal plugin exemplar (registers two view tabs into the conversation's `'conversation.view'` slot ring, provides no service, declares no Context merge). Contract: api-contracts v3 §8.

## Model Experience

None, as the trajectory views render session data in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **In-flight Time stays blank** — `partial` / `runningCalls` rows render with `—` until a live clock policy lands; selected styling is local-only (not wired to chat details); anchor deep-linking remains deferred.
