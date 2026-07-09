# Examples

Runnable demos (not workspaces) that showcase how the harness is wired. Each example is now a **thin leaf**: a `cordis.yml` that picks the swappable backends (an LLM adapter, a bash executor), loads ONE app package, and may add optional product tools or demo-only mocks. The composition — the spine, the front-door cluster, and the boot glue — lives in the app packages ([`@deepseek-ai/dsh-stdio-agent`](../packages/ui/stdio-agent), [`@deepseek-ai/dsh-acp-agent`](../packages/ui/acp-agent)) and the [`@deepseek-ai/dsh-agent-core`](../packages/core/agent-core) bundle they share. There is no `start.ts`; the `demo:*` scripts invoke each app package's `bin`.

## echo-agent

A mock model + echo tool on the stdio chat app — the all-mock skeleton. The leaf swaps `dsh-stdio-agent`'s LLM backend to a local `mock-echo` adapter and adds a local `echo` tool. Demonstrates:

- A thin leaf `cordis.yml` loading the `@deepseek-ai/dsh-stdio-agent` app
- Registering a mock `LlmAdapter` (streaming scripted responses)
- Registering a tool via `ctx.tools.register()`
- "Swap the backend, keep the app" — the only difference from `coding-agent` is the adapter

Run with: `pnpm run demo:echo`. When prompted, type "echo <something>" to trigger a tool call round-trip.

## coding-agent

A REPL agent demo: DeepSeek V4 + the `read`/`write`/`edit` filesystem tools + the bash tool suite, `subagent` delegation, and the `todo_write` task tracker on the same `@deepseek-ai/dsh-stdio-agent` app. The UI is a terminal readline REPL.

Run with: `pnpm run demo:repl` (needs `DEEPSEEK_API_KEY` in the environment or a gitignored repo-root `.env`). See [coding-agent/README.md](coding-agent/README.md) for details.

Its `code-mode.cordis.yml` overlay flips the same tree to **Code Mode**: the worker-thread code runtime is loaded and the tool registry runs `mode: code`, so the model gets exactly one wire tool — `run_code` — plus a generated TypeScript SDK section, and composes the other tools by writing a program whose output it curates. Run with: `pnpm run demo:code-mode` (the REPL is the default UI; `acp` as the argument serves the acp-agent example's same-shaped overlay instead) — see the [Code Mode section](coding-agent/README.md#code-mode) for what to try.

## cordis-agent

The **self-referential** demo: the coding spine plus [`@deepseek-ai/dsh-tool-cordis`](../packages/cordis/tool-cordis), whose three tools (`cordis_inspect` / `cordis_mount` / `cordis_unmount`) let the agent inspect the live cordis runtime it runs inside, mount model-written plugins into it (an event listener, a brand-new tool for itself, or a service another mount injects), and dispose them again — all dynamic mounts grouped under one `cordis-dynamic` fiber subtree. The `ctx.fs`/`ctx.web` services ride along provider-only, as the capabilities those plugins build on.

Run with: `pnpm run demo:cordis` (needs `DEEPSEEK_API_KEY`). See [cordis-agent/README.md](cordis-agent/README.md) for the staged demo script and [the toolset RFC](../docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) for the design and sandbox caveats.

## acp-agent

An agent demo exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio, via the [`@deepseek-ai/dsh-acp-agent`](../packages/ui/acp-agent) app — drive it from Zed or any other ACP client. Also the home of the keyless snapshot tests.

Run with: `pnpm run demo:acp` (needs `DEEPSEEK_API_KEY`); `pnpm run demo:code-mode acp` boots the same server in Code Mode via the `code-mode.cordis.yml` overlay. See [acp-agent/README.md](acp-agent/README.md) for the Zed setup and the snapshot-test design.
