# acp-agent example

Automation-oriented [Agent Client Protocol](https://agentclientprotocol.com) server over JSON-RPC stdio. It is intended for parent agents, subagent providers, and other programmatic clients, not as the product UI.

```sh
pnpm run demo:acp             # needs DEEPSEEK_API_KEY (repo-root .env or env)
pnpm run demo:code-mode acp   # same protocol with the Code Mode tool transport
```

The leaf loads the ACP app, DeepSeek adapter, sandboxed bash and filesystem stacks, one-shot approval policy, compaction, subagents, workflows, hooks, model-facing tools, and repeat guard. The app creates one fresh agent per `session/new`, persists sessions to JSONL, and keeps stdout protocol-pure. [`fs.cordis.yml`](fs.cordis.yml) adds local tool-result spill storage for dedicated scenarios; [`code-mode.cordis.yml`](code-mode.cordis.yml) adds `run_code` and its generated TypeScript SDK.

## Protocol channel

Stdout carries only newline-delimited ACP JSON-RPC. `@deepseek-ai/dsh-acp-demo` installs no stdout logger; leaf additions must use stderr for diagnostics.

The server accepts initialization/authentication, fresh text sessions, one in-flight prompt per session, cancellation, and one-shot permission decisions. It emits only committed assistant text. Session navigation, commands, modes, configuration pickers, elicitation, titles, plans, reasoning, tool cards, and terminal output are intentionally absent; the full contract lives in [`@deepseek-ai/dsh-acp`](../../packages/acp/acp/README.md).

## Session workspaces and permissions

Each `session/new` supplies an absolute `cwd`. Sandboxed bash and filesystem mutations resolve `workspace-write` against that session cwd, so concurrent sessions can use separate project roots; platform temporary roots remain shared writable scratch space ([sandbox contract](../../packages/sandbox/sandbox/README.md)). `DSH_PERMISSION_MODE` selects `workspace-write` or `danger-full-access` for deployment and tests.

Under `workspace-write`, a model retry requesting wider sandbox access triggers `session/request_permission` with `allow_once` and `reject_once`. The client decides programmatically; dismissal or an unavailable answer fails closed. The selected outcome applies only to that retry and is recorded through the normal tool-result/audit path. The server never exposes a permission picker or persists client policy.

## Snapshot tests

This example owns the ACP snapshot suite. It boots the real automation server, replays committed model streams through `dsh-llm-replay`, and compares both normalized protocol output and re-persisted session logs. Recording uses the real model; refresh reuses committed replay input. Overrides cover throw/hang behavior, and optional `workspace/` fixtures seed world-state checks.

Most scenarios pin backend behavior rather than ACP-specific behavior and remain in this suite until they can move without losing coverage. The FIXME in [`tests/acp.snapshot.ts`](tests/acp.snapshot.ts) names their migration to the headless `stream-json` suite.

## Protocol limitations

- Sessions are fresh and connection-owned; load, list, resume, close, delete, and fork are unsupported.
- Prompts accept text only; resource links, images, audio, embedded resources, non-empty additional directories, and MCP servers reject.
- Output is committed assistant text, not live progress, tool activity, reasoning, plans, titles, or usage.
- All sessions close with the connection; there is no per-session close method.
