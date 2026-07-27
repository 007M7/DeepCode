# llm/ — LLM capability family

English | [中文](README.zh.md)

The LLM seam and its provider adapters. The interface package (`llm`) owns the abstract service, the content-block vocabulary, and the stream-chunk assembler; the adapters are concrete implementations that register on `ctx.llm`. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `llm/` | Abstract LLM service + content-block vocabulary + chunk assembler | `ctx.llm` |
| `token-meter/` | Replay-aware request and surface token measurement | `ctx.tokenMeter` |
| `llm-retry/` | Bounded transient request retry policy | (listens to `agent/request-error`) |
| `llm-deepseek/` | DeepSeek API adapter (direct fetch + eventsource-parser SSE) | (registers on `ctx.llm`) |
| `llm-pi-ai/` | Multi-provider adapter via `@earendil-works/pi-ai` | (registers on `ctx.llm`) |

The interface lives at `llm/llm/`; adapters, retry policy, and the reusable token meter are flat siblings under the group. Requests route by `provider`, while `model` is passed through to the selected adapter. The route-owning adapter optionally resolves exact provider/model context capacity; the token meter remains model-agnostic. A new provider adapter registers one or more provider routes on `ctx.llm` without touching the interface or consumers. See [twin LLM adapters](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) for the two shipping implementations, the [replay token meter Agent Note](../../.agents/notes/implemented/architecture/2026-07-15-replay-token-meter-service.md) for measurement ownership, and the [routed model context Agent Note](../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md) for capacity and compaction-policy ownership.
