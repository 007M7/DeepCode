# Examples

Runnable demos (not workspaces) that showcase how the harness is wired.

## echo-agent

A mock model + echo tool + stdio UI + JSONL persistence demo. Demonstrates:

- Loading plugins from a `cordis.yml` via `@cordisjs/plugin-loader` + `@cordisjs/plugin-include`
- Registering a mock `LlmAdapter` (streaming scripted responses)
- Registering a tool via `ctx.tools.register()`
- Persisting session events to JSONL via the `session/event` + `session/flush` pattern
- A minimal stdio UI consuming `agent/stream-chunk` and session events

Run with: `pnpm run demo:echo`

When prompted, type "echo <something>" to trigger a tool call round-trip.

## coding-agent

The real thing: DeepSeek V4 + the bash tool suite + stdio chat + JSONL persistence, wired from `cordis.yml`. Where echo-agent proves the skeleton with mocks, this is a usable coding assistant.

Run with: `pnpm run demo:coding` (needs `DEEPSEEK_API_KEY` in the environment or a gitignored repo-root `.env`). See [coding-agent/README.md](coding-agent/README.md) for details.
