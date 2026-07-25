# Examples

Runnable demos (not workspaces) that showcase how the harness is wired. Each example is a **thin leaf**: a `cordis.yml` that picks swappable backends, loads one app package, and may add optional product tools. The composition and boot glue live in [`@deepseek-ai/dsh-tui-demo`](../packages/examples/tui-demo), [`@deepseek-ai/dsh-cli-demo`](../packages/examples/cli-demo), [`@deepseek-ai/dsh-acp-demo`](../packages/examples/acp-demo), and their shared [`@deepseek-ai/dsh-agent-spine-demo`](../packages/examples/agent-spine-demo) bundle. There is no `start.ts`; the terminal `demo:*` scripts boot through the [`dsh`](../apps/cli/README.md) CLI (which mounts the `tui-demo` bundle), and the headless/ACP scripts invoke the `cli-demo`/`acp-demo` bins.

## headless-agent

A non-interactive agent demo that accepts one positional task, runs one complete model/tool turn on the `@deepseek-ai/dsh-cli-demo` app, persists a fresh session, prints `text`, `json`, or `stream-json`, and exits.

Run with: `pnpm run demo:headless "task"` (needs `DEEPSEEK_API_KEY`). See [headless-agent/README.md](headless-agent/README.md) for the output contract, safety boundaries, and snapshot suite.

## tui-agent

The interactive coding agent: DeepSeek V4, filesystem and bash tools, subagents, workflows, `todo_write`, compaction, and the full-screen TUI. It is also the home of TUI PTY and snapshot scenarios.

Run with: `pnpm run demo:tui` (needs `DEEPSEEK_API_KEY`). Run its Code Mode overlay with `pnpm run demo:code-mode`. See [tui-agent/README.md](tui-agent/README.md) for controls and composition.

## jsonrpc-agent

An unattended coding agent driven through the Python SDK: JSON-RPC stdio, foreground-only `bash`, `read` / `write` / `edit`, one foreground `subagent`, `todo_write`, JSONL persistence, and compaction. It excludes terminal UI, stdout logging, approvals, skills, and background task controls. See [jsonrpc-agent/README.md](jsonrpc-agent/README.md).

## cordis-agent

The **self-referential** demo: the coding spine plus [`@deepseek-ai/dsh-tool-cordis`](../packages/cordis/tool-cordis), whose three tools (`cordis_inspect` / `cordis_mount` / `cordis_unmount`) let the agent inspect the live cordis runtime it runs inside, mount model-written plugins into it (an event listener, a brand-new tool for itself, or a service another mount injects), and dispose them again — all dynamic mounts grouped under one `cordis-dynamic` fiber subtree. The `ctx.fs`/`ctx.web` services ride along provider-only, as the capabilities those plugins build on.

Run with: `pnpm run demo:cordis` (needs `DEEPSEEK_API_KEY`). See [cordis-agent/README.md](cordis-agent/README.md) for the staged demo script and [the toolset Agent Note](../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) for the design and sandbox caveats.

## acp-agent

An agent exposed as an **Agent Client Protocol (ACP)** automation server over JSON-RPC stdio, via [`@deepseek-ai/dsh-acp-demo`](../packages/examples/acp-demo). Programmatic clients create fresh sessions, send text prompts, consume committed assistant text, answer one-shot permission requests, and cancel work. It owns the ACP keyless snapshot suite.

Run with: `pnpm run demo:acp` (needs `DEEPSEEK_API_KEY`); `pnpm run demo:code-mode acp` boots the same server in Code Mode via the `code-mode.cordis.yml` overlay. See [acp-agent/README.md](acp-agent/README.md) for the protocol and snapshot-test contracts.

The default `cordis.yml` composes [`@deepseek-ai/dsh-sandbox-local`](../packages/sandbox/sandbox-local), [`@deepseek-ai/dsh-bash-sandbox`](../packages/bash/bash-sandbox), and [`@deepseek-ai/dsh-user-approval`](../packages/ui/user-approval). `workspace-write` confines bash and filesystem mutations to each session workspace; a wider retry becomes a one-shot machine permission request over ACP.
