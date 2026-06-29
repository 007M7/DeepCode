# Examples

Runnable demos (not workspaces) that showcase how the harness is wired. Each example is now a **thin leaf**: a `cordis.yml` that picks the swappable backends (an LLM adapter, a bash executor) and loads ONE app package, plus any demo-only mocks. The composition — the spine, the front-door cluster, and the boot glue — lives in the app packages ([`@deepseek-ai/dsh-stdio-agent`](../packages/ui/stdio-agent), [`@deepseek-ai/dsh-acp-agent`](../packages/ui/acp-agent)) and the [`@deepseek-ai/dsh-agent-core`](../packages/core/agent-core) bundle they share. There is no `start.ts`; the `demo:*` scripts invoke each app package's `bin`.

## echo-agent

A mock model + echo tool on the stdio chat app — the all-mock skeleton. The leaf swaps `dsh-stdio-agent`'s LLM backend to a local `mock-echo` adapter and adds a local `echo` tool. Demonstrates:

- A thin leaf `cordis.yml` loading the `@deepseek-ai/dsh-stdio-agent` app
- Registering a mock `LlmAdapter` (streaming scripted responses)
- Registering a tool via `ctx.tools.register()`
- "Swap the backend, keep the app" — the only difference from `coding-agent` is the adapter

Run with: `pnpm run demo:echo`. When prompted, type "echo <something>" to trigger a tool call round-trip.

## coding-agent

The real thing: DeepSeek V4 + the bash tool suite, `subagent` delegation, and the `todo_write` task tracker on the same `@deepseek-ai/dsh-stdio-agent` app. Where echo-agent proves the skeleton with mocks, this is a usable coding assistant.

Run with: `pnpm run demo:coding` (needs `DEEPSEEK_API_KEY` in the environment or a gitignored repo-root `.env`). See [coding-agent/README.md](coding-agent/README.md) for details.

## acp-agent

The same coding agent exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio, via the [`@deepseek-ai/dsh-acp-agent`](../packages/ui/acp-agent) app — drive it from Zed or any other ACP client. Also the home of the keyless snapshot tests.

Run with: `pnpm run demo:acp` (needs `DEEPSEEK_API_KEY`). See [acp-agent/README.md](acp-agent/README.md) for the Zed setup and the snapshot-test design.
