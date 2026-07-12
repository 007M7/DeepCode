# acp-agent example

The DeepSeek Harness SDK agent demo exposed as an **Agent Client Protocol (ACP)** server over JSON-RPC stdio — drive it from Zed or any other ACP client.

```sh
pnpm run demo:acp          # needs DEEPSEEK_API_KEY (repo-root .env or env)
pnpm run demo:code-mode acp   # the same server in Code Mode: one wire tool, run_code
```

This example is just a leaf `cordis.yml`: it loads the [`@deepseek-ai/dsh-acp-agent`](../../packages/ui/acp-agent) app (which bundles the [`@deepseek-ai/dsh-agent-core`](../../packages/core/agent-core) spine, JSONL session persistence, and the `@deepseek-ai/dsh-acp` bridge — with **no pre-created agents**, since ACP `session/new` creates them on demand), the swappable DeepSeek, bash, and filesystem backends, the model-facing `read`/`write`/`edit`/`subagent`/`subagent_fork`/`todo_write` tool entries, and the advisory `repeat-tool-guard` loop-hygiene plugin. The app package bakes in the no-stdout-logger cluster, so a leaf has no logger entry to get wrong by default — keeping stdout pure for JSON-RPC. `demo:code-mode acp` boots the same tree through the [`code-mode.cordis.yml`](code-mode.cordis.yml) overlay — the tool surface collapses to `run_code` + the generated TypeScript SDK, dispatching through the worker-thread code runtime (see the [dsh-tools Code Mode section](../../packages/core/tools/README.md#code-mode)).

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

This example is the home of the harness's **snapshot tests** — they boot this server as a real subprocess, drive it with a deterministic input script, and diff its normalized output against committed golden files. The model is made deterministic by `@deepseek-ai/dsh-llm-replay`, a function/namespace plugin that installs an `llm/stream` waterfall listener and short-circuits it, serving model streams reconstructed from a recorded **session JSONL** fixture (`<scenario>/session.jsonl`) — so replay needs no API key. The fixture IS the persisted session log: its `assistant/chunk` events carry every `StreamChunk`, so grouping them by `(turn, step)` reconstructs each `stream()` call (one model call per loop step). Recording is therefore "run the real agent once and harvest the `.jsonl`"; use `pnpm run test:snapshot:record` when the model transcript itself should change, and `pnpm run test:snapshot:refresh` when the committed model transcript is still the right mock input and only the current replay output/goldens need to be rewritten. The two failure modes not expressible as logged chunks — a pure throw before any chunk, and cancel/hang — use an optional `<scenario>/replay.override.json` sidecar (a `ReplayEntry[]` that replaces the derived script). A scenario that needs the agent to operate on existing files ships an optional `<scenario>/workspace/` directory — the harness copies its contents into the temp cwd before the run (see `workspace-edit`). See [the ACP snapshot tests RFC](../../docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md) for the full design.

## The sandbox variant (`sandbox.cordis.yml`)

The same server with the bash executor swapped for the sandbox stack ([`@deepseek-ai/dsh-sandbox-local`](../../packages/sandbox/sandbox-local/) + [`@deepseek-ai/dsh-bash-sandbox`](../../packages/bash/bash-sandbox/) — the one-entry executor swap the `ctx.bash` capability seam exists for) plus [`@deepseek-ai/dsh-user-approval`](../../packages/ui/user-approval/) — the composition where the approval loop is LIVE end to end: bash runs under `read-only`, a denial comes back as the structured marker, the model retries once with `sandbox_permissions` + `justification`, the ACP bridge's answerer turns that ask into a `session/request_permission` prompt in your editor, and "Allow once" runs exactly that command under the wider mode ([sandbox RFC § Escalation](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)). Run it with `pnpm run demo:sandbox-acp`; Zed setup is the same as above with this command.

- **Every approval is one-shot** (`Allow once` / `Reject` — no `allow_always`: the harness has no grant storage yet), and a dismissed prompt or a rejected ask fails closed with its own error text; so does every ask when no editor is attached to answer.
- **One session config option is live** ([sandbox RFC § Per-session mode switching](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)): a capable client shows a `Permissions` select per session (`request` = workspace-write + ask, `yolo` = danger-full-access + never — the `@deepseek-ai/dsh-permission` preset table), and a switch is one log-only `permission/preset` event written through to the two knob events, execution following the knobs; the sandbox mode is deliberately NOT stated in the prompt or narrated (the model learns the boundary from the denial marker — behavior, not belief), while an approval switch to `never` is stated and narrated; a resumed session reports its overrides back on `session/load`.
- **The write boundary is config-fixed**: an escalated `workspace-write` run may write under the launch directory (`workspaceRoot: process.cwd()`) plus the platform temp area — a per-session root is config-phase future work in the [sandbox RFC](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).
- **No usable runner fails closed per command** (structured `SANDBOX_UNAVAILABLE`), and the variant loads no filesystem tools: they would bypass the bash sandbox.

Variant tests, in this example's suites: `tests/escalation.e2e.ts` — keyless, it boots the real `sandbox.cordis.yml` through the Loader as an ACP subprocess, proves the whole tree (sandbox executor + approval service + bridge) initializes and opens a session, and drives the config options end to end; with a key and a usable runner, a scripted ACP client plays the human — the real model escalates a user-asserted denial, the client answers `allow-once`, and the retried write must land on disk. Four scenarios in `tests/acp.snapshot.ts` run against the variant's `sandbox.cordis.snapshot.yml` replay overlay under the `sandbox` header class: the keyless `config-options` exchange, the recorded `permission-switching` arc (that class's pinned header — one `request`→`yolo` preset switch, its approval prompt-section delta and "changed by the user" notice), and both recorded escalation branches (`session/request_permission` answered allow-once / reject-once). Replay re-executes every recorded bash call under the host's real runner — Seatbelt works out of the box on macOS; on Linux install bubblewrap first, exactly what ci.yml's snapshot lane does. No fixture carries a real denial: denial stderr is backend dialect and would pin a fixture to its recording platform (the rationale comment atop the suite file).

## MVP limitations

The bridge supports N concurrent sessions per connection, each in its own workspace `cwd` (RFC 011). Remaining limits: prompts support ACP's baseline `text` and `resource_link` blocks only, and `additionalDirectories` and `mcpServers` are rejected. Permission prompts (`session/request_permission`) are wired through the approval seam; the MAIN tree composes no ask-producing policy, so its tools run with the executor's full authority — the sandbox variant above is the composition that exercises the live prompt. See `packages/ui/acp/README.md` for the full contract.
