# Examples

English | [中文](README.zh.md)

Runnable demos (not workspaces) that showcase how the harness is wired. Each example is a **thin leaf**: either a `cordis.yml` tree that picks swappable backends and loads one app package, or an **overlay** — a patch list `dsh --config` applies over the shipped composition ([`apps/cli/config/base.cordis.yml`](../apps/cli/config/base.cordis.yml) plus a surface overlay). Bundled compositions live in [`@deepseek-ai/dsh-cli-demo`](../packages/examples/cli-demo), [`@deepseek-ai/dsh-acp-demo`](../packages/examples/acp-demo), and their shared [`@deepseek-ai/dsh-agent-spine-demo`](../packages/examples/agent-spine-demo) bundle; the `dsh` surfaces use flat config trees instead. There is no `start.ts`; the terminal `demo:*` scripts boot through the [`dsh`](../apps/cli/README.md) CLI, and the headless/ACP scripts invoke the `cli-demo`/`acp-demo` bins.

## mcp-memory

Three default-off reference overlays connect a memory MCP server through the generic MCP client. Pick one file and pass it to `dsh --config`; DSH does not install or configure the upstream memory system. See [mcp-memory/README.md](mcp-memory/README.md) for pinned prerequisites, identity mapping, the shared optional prompt, and the write → fresh-session recall → use verification recipe.

## headless-agent

A non-interactive agent demo that accepts one positional task, runs one complete model/tool turn on the `@deepseek-ai/dsh-cli-demo` app, persists a fresh session, prints `text`, `json`, or `stream-json`, and exits.

Run with: `pnpm run demo:headless "task"` (needs `DEEPSEEK_API_KEY`). See [headless-agent/README.md](headless-agent/README.md) for the output contract, safety boundaries, and snapshot suite.

## jsonrpc-agent

An unattended coding agent driven through the Python SDK: JSON-RPC stdio, foreground-only `bash`, `read` / `write` / `edit`, one foreground `subagent`, `todo_write`, JSONL persistence, and compaction. It excludes terminal UI, stdout logging, approvals, skills, and background task controls. See [jsonrpc-agent/README.md](jsonrpc-agent/README.md).

## web-cordis

The **self-referential** demo: the coding spine plus [`@deepseek-ai/dsh-tool-cordis`](../packages/cordis/tool-cordis), whose three tools (`cordis_inspect` / `cordis_mount` / `cordis_unmount`) let the agent inspect the current DSH process, mount model-written temporary Plugins (an event listener, a brand-new tool, or a service another temporary Plugin injects), and unmount them again. These Plugins exist only in memory and share one internal `cordis-dynamic` fiber subtree; `ctx.fs`/`ctx.web` ride along provider-only as capabilities they can use.

Run the browser UI at `http://127.0.0.1:3081` with `pnpm run demo:cordis`, or the ACP server with `pnpm run demo:cordis acp` (both need `DEEPSEEK_API_KEY`). See [the toolset Agent Note](../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) for the design and sandbox caveats.

## acp-agent

An agent exposed as an **Agent Client Protocol (ACP)** automation server over JSON-RPC stdio, via [`@deepseek-ai/dsh-acp-demo`](../packages/examples/acp-demo). Programmatic clients create fresh sessions, send text prompts, consume committed assistant text, answer one-shot permission requests, and cancel work. It owns the ACP keyless snapshot suite.

Run with: `pnpm run demo:acp` (needs `DEEPSEEK_API_KEY`); `pnpm run demo:code-mode` boots the same server in Code Mode via the `code-mode.cordis.yml` overlay. See [acp-agent/README.md](acp-agent/README.md) for the protocol and snapshot-test contracts.

The default `cordis.yml` composes [`@deepseek-ai/dsh-sandbox-local`](../packages/sandbox/sandbox-local), [`@deepseek-ai/dsh-bash-sandbox`](../packages/bash/bash-sandbox), and [`@deepseek-ai/dsh-user-approval`](../packages/ui/user-approval). `workspace-write` confines bash and filesystem mutations to each session workspace; a wider retry becomes a one-shot machine permission request over ACP.
