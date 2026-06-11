# Examples

Runnable demos (not workspaces) that showcase how the harness is wired.

## echo-agent

A mock model + echo tool + stdio UI + JSONL persistence demo. Demonstrates:

- Loading plugins from a `cordis.yml` via `@cordisjs/plugin-loader` + `@cordisjs/plugin-include`
- Registering a mock `LlmAdapter` (streaming scripted responses)
- Registering a tool via `ctx.tools.register()`
- Persisting session events to JSONL via the `session/event` + `session/flush` pattern
- A minimal stdio UI consuming `agent/stream-chunk` and session events

Run with: `yarn demo` (or `node --expose-internals --import tsx examples/echo-agent/start.ts`)

When prompted, type "echo <something>" to trigger a tool call round-trip.
