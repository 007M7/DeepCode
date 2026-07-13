# acp-agent example

The DeepSeek Harness SDK agent demo exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio — drive it from Zed or any other ACP client.

```sh
pnpm run demo:acp          # needs DEEPSEEK_API_KEY (repo-root .env or env)
pnpm run demo:code-mode acp   # the same server in Code Mode: one wire tool, run_code
```

This example is one leaf `cordis.yml`: it loads the [`@deepseek-ai/dsh-acp-agent`](../../packages/ui/acp-agent) app (the [`@deepseek-ai/dsh-agent-core`](../../packages/core/agent-core) spine, JSONL session persistence, and the `@deepseek-ai/dsh-acp` bridge), the DeepSeek adapter, sandboxed bash, approval and permission services, subagent/workflow/todo tools, and the advisory `repeat-tool-guard`. ACP `session/new` creates agents on demand. The app package bakes in the no-stdout-logger cluster, so the leaf has no logger entry to get wrong by default. `demo:code-mode acp` boots the same tree through [`code-mode.cordis.yml`](code-mode.cordis.yml), collapsing the tool surface to `run_code` plus the generated TypeScript SDK (see the [dsh-tools Code Mode section](../../packages/core/tools/README.md#code-mode)).

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

The editor sets each session's `cwd` to the project it opens, and bash uses that directory as its workdir. The current sandbox write boundary is nevertheless fixed when the server starts (`workspaceRoot: process.cwd()`), so launch the server from the workspace it should be allowed to modify; making that root session-scoped is deferred in the [sandbox RFC](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md). Filesystem tools are omitted from the confined default because they execute in-process and do not ride the bash sandbox.

## Snapshot tests (record-once / replay-deterministic)

This example is the home of the harness's **snapshot tests** — they boot this server as a real subprocess, drive it with a deterministic input script, and diff its normalized output against committed golden files. The model is made deterministic by `@deepseek-ai/dsh-llm-replay`, a function/namespace plugin that installs an `llm/stream` waterfall listener and short-circuits it, serving model streams reconstructed from a recorded **session JSONL** fixture (`<scenario>/session.jsonl`) — so replay needs no API key. The fixture IS the persisted session log: its `assistant/chunk` events carry every `StreamChunk`, so grouping them by `(turn, step)` reconstructs each `stream()` call (one model call per loop step). Recording is therefore "run the real agent once and harvest the `.jsonl`"; use `pnpm run test:snapshot:record` when the model transcript itself should change, and `pnpm run test:snapshot:refresh` when the committed model transcript is still the right mock input and only the current replay output/goldens need to be rewritten. The two failure modes not expressible as logged chunks — a pure throw before any chunk, and cancel/hang — use an optional `<scenario>/replay.override.json` sidecar (a `ReplayEntry[]` that replaces the derived script). A scenario that needs the agent to operate on existing files ships an optional `<scenario>/workspace/` directory — the harness copies its contents into the temp cwd before the run (see `workspace-edit`). See [the ACP snapshot tests RFC](../../docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md) for the full design.

## Permissions and sandboxing

The default tree composes [`@deepseek-ai/dsh-sandbox-local`](../../packages/sandbox/sandbox-local/), [`@deepseek-ai/dsh-bash-sandbox`](../../packages/bash/bash-sandbox/), [`@deepseek-ai/dsh-user-approval`](../../packages/ui/user-approval/), and [`@deepseek-ai/dsh-permission`](../../packages/ui/permission/). Bash starts in `workspace-write`; a denied operation returns a structured marker, and a retry with `sandbox_permissions` plus `justification` becomes a one-shot `session/request_permission` prompt in the editor. "Allow once" runs exactly that retry under the wider mode ([sandbox RFC § Escalation](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)).

- **One session config option is live**: a capable client shows one `Permissions` select. `workspace-write` means workspace-confined bash plus `ask`; `danger-full-access` means unconfined file access plus `never`. Switching writes one `permission/preset` event through to the sandbox-mode and approval-policy events, and `session/load` reports the resumed value.
- **Every approval is one-shot**: the choices are `Allow once` and `Reject`; a dismissal, rejection, missing editor, or unavailable runner fails closed.
- **The boundary is bash-only and config-fixed today**: in-process filesystem tools are omitted from the confined live default, while the sandbox workspace root remains the server's launch directory.

`tests/escalation.e2e.ts` boots this default tree keyless, drives the permission select, and—with a key and usable runner—proves both approval outcomes against the filesystem. The snapshot suite uses the same tree: snapshot mode starts at `danger-full-access` so established fixtures remain runner-independent, while the permission-switching and escalation inputs explicitly select `workspace-write` before exercising that policy path. No fixture pins a real denial because kernel error text is backend-specific; real confinement remains covered by the sandbox packages' kernel e2e suites.

## MVP limitations

The bridge supports N concurrent sessions per connection, each with its own `cwd` (RFC 011). Prompts support ACP's baseline `text` and `resource_link` blocks only; `additionalDirectories` and `mcpServers` are rejected. See [`packages/ui/acp/README.md`](../../packages/ui/acp/README.md) for the full contract.
