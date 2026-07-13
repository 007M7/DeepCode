# acp-agent example

The DeepSeek Harness SDK agent demo exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio — drive it from Zed or any other ACP client.

```sh
pnpm run demo:acp          # needs DEEPSEEK_API_KEY (repo-root .env or env)
pnpm run demo:code-mode acp   # the same server in Code Mode: one wire tool, run_code
```

The leaf config loads the ACP app, swappable backends, model-facing tools, and repeat guard. The app bundles the agent spine, JSONL persistence, and bridge, creates agents on `session/new`, and keeps stdout logger-free. [`code-mode.cordis.yml`](code-mode.cordis.yml) overlays the same tree with `run_code`; see [Code Mode](../../packages/core/tools/README.md#code-mode).

## stdout is the protocol

This example loads **no stdout logger** — `stdout` carries the JSON-RPC frames, and any other write corrupts them. `@deepseek-ai/dsh-acp-agent` includes no logger entry, so this leaf has none to get wrong by default; do not add one (use a stderr exporter if you need logs).

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

The editor sets each session's `cwd` to the project it opens; both the agent's bash tools and the `read`/`write`/`edit` filesystem tools resolve relative paths against that per-session workspace (see the per-session `cwd` note in `packages/ui/acp` and [the per-session cwd RFC](../../docs/rfc/implemented/architecture/2026-07-02-fs-per-session-cwd.md)), so the server can be launched anywhere and each session still acts on its own project directory.

## Snapshot tests (record-once / replay-deterministic)

This example hosts the ACP snapshot suite. `dsh-llm-replay` reconstructs model streams from `assistant/chunk` events in each scenario's session JSONL, so replay is keyless. Recording runs the real agent and harvests that log; refresh keeps the committed transcript as mock input and rewrites current replay outputs. `replay.override.json` covers throw and hang cases that chunks cannot express, and an optional `workspace/` seeds files. The [snapshot RFC](../../docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md) owns the full design.

## MVP limitations

The bridge supports N concurrent sessions per connection, each in its own workspace `cwd` (RFC 011). Remaining limits: prompts support ACP's baseline `text` and `resource_link` blocks only, and `additionalDirectories` and `mcpServers` are rejected. Permission prompts (`session/request_permission`) are wired through the approval seam, but this example composes no ask-producing policy, so tools run with the executor's full authority. See `packages/ui/acp/README.md` for the full contract.
