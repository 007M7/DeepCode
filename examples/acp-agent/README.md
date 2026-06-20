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
      "args": ["--dir", "/path/to/deepseek-harness", "run", "demo:acp"],
      "env": { "DEEPSEEK_API_KEY": "sk-…" }
    }
  }
}
```

The editor sets each session's `cwd` to the project it opens; the agent's bash tools run there (see the per-session `cwd` note in `packages/ui/acp`), so launch the server from the harness repo with `pnpm --dir …` and let ACP carry the workspace path per session.

## Snapshot tests (record-once / replay-deterministic)

This example is the home of the harness's **snapshot tests** — they boot this server as a real subprocess, drive it with a deterministic input script, and diff its normalized output against committed golden files. The model is made deterministic by `@deepseek-ai/dsh-llm-replay`, a function/namespace plugin that installs an `llm/stream` waterfall listener and short-circuits it, serving model streams reconstructed from a recorded **session JSONL** fixture (`<scenario>/session.jsonl`) — so replay needs no API key. The fixture IS the persisted session log: its `assistant/chunk` events carry every `StreamChunk`, so grouping them by `(turn, step)` reconstructs each `stream()` call (one model call per loop step). Recording is therefore "run the real agent once and harvest the `.jsonl`". The two failure modes not expressible as logged chunks — a pure throw before any chunk, and cancel/hang — use an optional `<scenario>/replay.override.json` sidecar (a `ReplayEntry[]` that replaces the derived script). A scenario that needs the agent to operate on existing files ships an optional `<scenario>/workspace/` directory — the harness copies its contents into the temp cwd before the run (see `workspace-edit`). See [docs/rfc/implemented/2026-06-19-acp-snapshot-tests.md](../../docs/rfc/implemented/2026-06-19-acp-snapshot-tests.md) for the full design.

## MVP limitations

The bridge supports N concurrent sessions per connection, each in its own workspace `cwd` (RFC 011). Remaining limits: prompts support ACP's baseline `text` and `resource_link` blocks only, `additionalDirectories` and `mcpServers` are rejected, and the tool-permission gate is deferred (`TODO(rfc010-permission-gate)` — tools run with the executor's full authority). See `packages/ui/acp/README.md` for the full contract.
