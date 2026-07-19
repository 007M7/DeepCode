# acp-agent example

The DeepSeek Harness SDK agent demo exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio — drive it from Zed or any other ACP client.

```sh
pnpm run demo:acp          # needs DEEPSEEK_API_KEY (repo-root .env or env)
pnpm run demo:code-mode acp   # the same server in Code Mode: one wire tool, run_code
```

The leaf config loads the ACP app, DeepSeek adapter, sandboxed bash, approval and permission services, model-facing tools, and repeat guard. The app bundles the agent spine, JSONL persistence, and bridge, creates agents on `session/new`, and keeps stdout logger-free. [`fs.cordis.yml`](fs.cordis.yml) adds the unconfined in-process filesystem stack and local tool-result spill storage for its dedicated scenarios; [`code-mode.cordis.yml`](code-mode.cordis.yml) adds `run_code` and its generated TypeScript SDK. See [Code Mode](../../packages/core/tools/README.md#code-mode).

## stdout is the protocol

This example loads **no stdout logger** — `stdout` carries the JSON-RPC frames, and any other write corrupts them. `@deepseek-ai/dsh-acp-demo` includes no logger entry, so this leaf has none to get wrong by default; do not add one (use a stderr exporter if you need logs).

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

The editor sets each session's `cwd` to the project it opens, and bash uses that directory as its workdir. The current sandbox write boundary is nevertheless fixed when the server starts (`workspaceRoot: process.cwd()`), so launch the server from the workspace it should be allowed to modify; making that root session-scoped is deferred in the [sandbox Agent Note](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md). Filesystem tools are omitted from the confined default because they execute in-process and do not ride the bash sandbox.

## Snapshot tests (record-once / replay-deterministic)

This example hosts the ACP snapshot suite. It replays through `dsh-llm-replay`, which reconstructs model streams from `assistant/chunk` events in each scenario's session JSONL. Recording runs the real ACP agent and harvests its logs; refresh keeps the committed transcript as mock input and rewrites current replay outputs. `replay.override.json` covers throw and hang cases that chunks cannot express, and an optional `workspace/` seeds files. The [snapshot Agent Note](../../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md) owns the ACP harness design.

## Permissions and sandboxing

The default tree composes [`@deepseek-ai/dsh-sandbox-local`](../../packages/sandbox/sandbox-local/), [`@deepseek-ai/dsh-bash-sandbox`](../../packages/bash/bash-sandbox/), [`@deepseek-ai/dsh-user-approval`](../../packages/ui/user-approval/), and [`@deepseek-ai/dsh-permission`](../../packages/ui/permission/). Bash starts in `workspace-write`; a denied operation returns a structured marker, and a retry with `sandbox_permissions` plus `justification` becomes a one-shot `session/request_permission` prompt in the editor. "Allow once" runs exactly that retry under the wider mode ([sandbox Agent Note § Escalation](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)).

- **One session config option is live**: a capable client shows one `Permissions` select. `workspace-write` means workspace-confined bash plus `ask`; `danger-full-access` means unconfined bash plus `never`. Switching writes one `permission/preset` event through to the sandbox-mode and approval-policy events, and `session/load` reports the resumed value.
- **Every approval is one-shot**: the choices are `Allow once` and `Reject`; a dismissal, rejection, missing editor, or unavailable runner fails closed.
- **The boundary is bash-only and config-fixed today**: in-process filesystem tools are omitted from the confined live default, while the sandbox workspace root remains the server's launch directory.

`tests/escalation.e2e.ts` boots this default tree keyless, drives the permission select, and—with a key and usable runner—proves both approval outcomes against the filesystem. Most snapshots use that tree and start at `danger-full-access` so bash fixtures remain runner-independent; scenarios that call `read`, `write`, or `edit` use the fixed full-access fs overlay and a separate request-header pin. The permission-switching and escalation inputs select `workspace-write` before exercising the bash policy path. No fixture pins a real denial because kernel error text is backend-specific; real confinement remains covered by the sandbox packages' kernel e2e suites.

## MVP limitations

The bridge supports N concurrent sessions per connection, each with its own `cwd` (RFC 011). Prompts support ACP's baseline `text` and `resource_link` blocks only; `additionalDirectories` and `mcpServers` are rejected. See [`packages/ui/acp/README.md`](../../packages/ui/acp/README.md) for the full contract.
