# llm/ — LLM capability family

The LLM seam and its provider adapters. The interface package (`llm`) owns the abstract service, the content-block vocabulary, and the stream-chunk assembler; the adapters are concrete implementations that register on `ctx.llm`. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `llm/` | Abstract LLM service + content-block vocabulary + chunk assembler | `ctx.llm` |
| `token-meter/` | Replay-aware request and surface token measurement | `ctx.tokenMeter` |
| `llm-deepseek/` | DeepSeek API adapter (hand-rolled fetch/SSE) | (registers on `ctx.llm`) |
| `llm-pi-ai/` | Multi-provider adapter via `@earendil-works/pi-ai` | (registers on `ctx.llm`) |

The interface lives at `llm/llm/`; adapters and the reusable token meter are flat siblings under the group. Requests route by `provider`, while `model` is passed through to the selected adapter. A new provider adapter joins here and registers one or more provider routes on `ctx.llm` without touching the interface. See [twin LLM adapters](../../docs/rfc/implemented/architecture/2026-06-13-twin-llm-adapters.md) for the contract-validation origin of the two shipping implementations and the [replay token meter RFC](../../docs/rfc/implemented/architecture/2026-07-15-replay-token-meter-service.md) for measurement ownership.
