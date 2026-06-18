# acp-agent example

The DeepSeek Harness coding agent exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio — drive it from Zed or any other ACP client.

```sh
pnpm run demo:acp          # needs DEEPSEEK_API_KEY (repo-root .env or env)
```

This boots `@deepseek-ai/dsh-acp` over the shared provider/tool core (`../base.yml`), with `agent-loop` configured with **no pre-created agents** (ACP `session/new` creates them on demand) and JSONL session persistence (so `session/load` works).

## stdout is the protocol

This example loads **no stdout logger** — `stdout` carries the JSON-RPC frames, and any other write corrupts them. Do not add `@cordisjs/plugin-logger-console` or a stdio UI here. Use a stderr exporter if you need logs.

## Zed configuration

Add to your Zed `settings.json` under `agent_servers`:

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "pnpm",
      "args": ["run", "demo:acp"],
      "env": { "DEEPSEEK_API_KEY": "sk-…" }
    }
  }
}
```

The editor sets each session's `cwd` to the project it opens; the agent's bash tools run there (see the per-session `cwd` note in `packages/acp`), so the server does not need to be launched in the workspace.

## Snapshot tests (record-once / replay-deterministic)

This example is the home of the harness's **snapshot tests** — they boot this server as a real subprocess, drive it with a deterministic input script, and diff its normalized stdout transcript against a committed golden file. The model is made deterministic by `src/llm-replay.ts`, a function/namespace plugin that installs an `llm/stream` waterfall listener: in `record` mode it tees the real model's `StreamChunk`s into a per-scenario `llm.json` (flushed atomically after each call); in `replay` mode it short-circuits the waterfall and serves those chunks back, so replay needs no API key. Each fixture entry is a discriminated record — `{ kind: 'chunks' | 'throw' | 'hang' }` — so both LLM failure branches (throw vs. finish-error) and cancellation replay faithfully. See [docs/rfc/implemented/2026-06-19-acp-snapshot-tests.md](../../docs/rfc/implemented/2026-06-19-acp-snapshot-tests.md) for the full design.

## MVP limitations

The bridge supports N concurrent sessions per connection, each in its own workspace `cwd` (RFC 011). Remaining limits: text-only prompts, `additionalDirectories` rejected (a session operates in its single `cwd`), and the tool-permission gate is deferred (`TODO(rfc010-permission-gate)` — tools run with the executor's full authority). See `packages/acp/README.md` for the full contract.
