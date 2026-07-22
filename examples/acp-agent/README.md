# acp-agent example

The DeepSeek Harness SDK agent demo exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio — drive it from Zed or any other ACP client.

```sh
pnpm run demo:acp          # needs DEEPSEEK_API_KEY (repo-root .env or env)
pnpm run demo:code-mode acp   # the same server in Code Mode: one wire tool, run_code
```

The leaf config loads the ACP app, DeepSeek adapter, plan mode, sandboxed bash, the sandboxed filesystem stack, approval and permission services, model-facing tools, and repeat guard. The app bundles the agent spine, JSONL persistence, and bridge, creates agents on `session/new`, and keeps stdout logger-free. [`fs.cordis.yml`](fs.cordis.yml) adds local tool-result spill storage for its dedicated scenarios; [`code-mode.cordis.yml`](code-mode.cordis.yml) adds `run_code` and its generated TypeScript SDK. See [Code Mode](../../packages/core/tools/README.md#code-mode).

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

The editor sets each session's `cwd` to the project it opens. That directory is both bash's default workdir and the session's primary `workspace-write` boundary: every bash or filesystem mutation carries one policy resolved from the calling session, so a single server process may serve concurrent projects. Projects outside the platform temporary areas do not grant either session writes into the other; `/tmp` and `os.tmpdir()` remain shared writable scratch roots under `workspace-write`, so projects placed there are not mutually isolated ([writable-root contract](../../packages/sandbox/sandbox/README.md)). The configured `workspaceRoot: process.cwd()` remains the fallback for calls without a session cwd. The filesystem tools ride the same policy through [`@deepseek-ai/dsh-fs-sandbox`](../../packages/fs/fs-sandbox/), so `read`/`write`/`edit` are available under every mode and confined to the same policy.

## Plan mode

The same `demo:acp` server composes [`@deepseek-ai/dsh-plan-mode`](../../packages/plan/plan-mode/), so a capable client advertises `default` and `plan` in its mode picker. ACP owns those protocol ids and projects them onto the plugin's boolean plan state. This composition owns the complete plan instructions in [`cordis.yml`](cordis.yml): remain in plan mode, inspect before asking, avoid mutations, resolve discoverable repository facts, and submit a decision-complete plan through `exit_plan_mode`. Those are the instrumental behaviors shared by the local Codex and Claude Code references; product-specific plan files, phase machinery, and protocol tags stay out of the plugin contract.

Plan mode adds only that configured guidance section. Every tool, including `exit_plan_mode`, keeps the same schema while plan mode is inactive or active; the exit tool describes itself as plan-only and rejects if called while inactive. Stable native schemas and Code Mode SDK bindings avoid tool-catalog churn at the transition. `ask_user_question` carries blocking user-owned choices through ACP elicitation, while `exit_plan_mode` renders the exact logged plan for approval and returns keep-planning feedback to the model. The mode picker and permission select remain independent: switching plan state never changes sandbox or approval state, and deployments that need a hard read-only planning floor configure that policy separately. The [plan-mode Agent Note](../../.agents/notes/implemented/feature/2026-07-07-plan-mode.md) owns the state and review contract.

## Snapshot tests (record-once / replay-deterministic)

This example hosts the ACP snapshot suite, including the picker advertisement and both plan-review branches. It replays through `dsh-llm-replay`, which reconstructs model streams from `assistant/chunk` events in each scenario's session JSONL. Recording runs the real ACP agent and harvests its logs; refresh keeps the committed transcript as mock input and rewrites current replay outputs. `replay.override.json` covers throw and hang cases that chunks cannot express, and an optional `workspace/` seeds files. The [snapshot Agent Note](../../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md) owns the ACP harness design.

## Permissions and sandboxing

The default tree composes [`@deepseek-ai/dsh-sandbox-local`](../../packages/sandbox/sandbox-local/), [`@deepseek-ai/dsh-sandbox-policy`](../../packages/sandbox/sandbox-policy/), [`@deepseek-ai/dsh-bash-sandbox`](../../packages/bash/bash-sandbox/), [`@deepseek-ai/dsh-fs-sandbox`](../../packages/fs/fs-sandbox/), [`@deepseek-ai/dsh-user-approval`](../../packages/ui/user-approval/), and [`@deepseek-ai/dsh-permission`](../../packages/ui/permission/). Bash and the `read`/`write`/`edit` tools start in `workspace-write`; a denied operation returns a structured marker, and a retry with `sandbox_permissions` plus `justification` becomes a one-shot `session/request_permission` prompt in the editor. "Allow once" runs exactly that retry under the wider mode ([sandbox Agent Note § Escalation](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)).

- **One session config option is live**: a capable client shows one `Permissions` select. `workspace-write` means workspace-confined bash plus `ask`; `danger-full-access` means unconfined bash plus `never`. Switching writes one `permission/preset` event through to the sandbox-mode and approval-policy events, and `session/load` reports the resumed value.
- **Every approval is one-shot**: the choices are `Allow once` and `Reject`; a dismissal, rejection, missing editor, or unavailable runner fails closed.
- **The boundary spans bash and the filesystem tools per session**: bash confines through the OS runner and the `read`/`write`/`edit` tools through an in-process path fence ([`dsh-fs-sandbox`](../../packages/fs/fs-sandbox/)); both receive the calling session's cwd as `workspaceRoot`.

`tests/escalation.e2e.ts` boots this default tree keyless, drives the permission select, and—with a key and usable runner—proves both approval outcomes against the filesystem. The agent-spine e2e independently boots one context with two home-directory project sessions and world-verifies concurrent own-root success plus sibling-root denial through both shipped tool families. The keyless `session-sandbox-root` ACP snapshot places its generated project under the user home while an overlay points the deployment fallback at `/tmp`; its successful `workspace-write` call proves the assembled app used the session cwd. Most snapshots start at `danger-full-access` so bash fixtures remain runner-independent. No fixture pins real runner denial text because its dialect is platform-specific.

## MVP limitations

The bridge supports N concurrent sessions per connection, each with its own `cwd` (RFC 011). Prompts support ACP's baseline `text` and `resource_link` blocks only; `additionalDirectories` and `mcpServers` are rejected. See [`packages/ui/acp/README.md`](../../packages/ui/acp/README.md) for the full contract.
