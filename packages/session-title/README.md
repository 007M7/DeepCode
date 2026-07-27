# session-title/ — log-backed session-title capability family

English | [中文](README.zh.md)

Durable session-title state, one optional asynchronous provider seam, and two opt-in model-backed implementations. The built-in first-message fallback is part of the service, so every composition can title a session without an auxiliary model call.

| Package | Role | ctx key |
|---|---|---|
| [`session-title/`](session-title/README.md) | Log fold, deterministic fallback, provider registry, and refresh API | `ctx.sessionTitle` |
| [`session-title-llm/`](session-title-llm/README.md) | Shared route, request logging, prompt, timeout, stream, and validation helper | — |
| [`session-title-first-message-llm/`](session-title-first-message-llm/README.md) | Optional provider using the first eligible human message | registers on `ctx.sessionTitle` |
| [`session-title-all-messages-llm/`](session-title-all-messages-llm/README.md) | Optional provider using every eligible human message | registers on `ctx.sessionTitle` |

Only one provider may register at a time. The shared demo spine mounts the fallback service but leaves both model providers outside default composition, so deployments choose auxiliary cost and retitling cadence explicitly.
