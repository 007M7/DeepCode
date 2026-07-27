# tui-agent

English | [中文](README.zh.md)

The full-screen interactive coding agent: DeepSeek V4, local bash and filesystem tools, compaction, subagents, workflows and fresh-agent Ralph iteration, plan mode (`/plan` enters and `exit_plan_mode` reviews the exit), timeout/spill policy, and JSONL persistence through [`@deepseek-ai/dsh-tui-demo`](../../packages/examples/tui-demo), loaded from `cordis.yml`. The sibling [`headless-agent`](../headless-agent/README.md) runs the same capability class as a one-shot pipe-friendly task, and [`acp-agent`](../acp-agent/README.md) serves it over JSON-RPC.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:tui
```

Both the demo script and the installable `dsh` CLI ([`apps/cli`](../../apps/cli/README.md)) boot this example's `cordis.yml` as the shipped default config; `dsh` additionally applies the personal overlay from `~/.dsh` and uses the invoking directory as the workspace.

Type a coding task. The agent works through the `read`/`write`/`edit` filesystem tools for ordinary file operations and `bash` (+ the generic `task_output` / `task_list` / `task_kill` for background tasks) for shell commands, searches, and test runs, each in a fresh `bash -c` (the system prompt tells the model to pass `workdir` instead of `cd`). Both the fs tools and bash resolve relative paths against the session workspace. It can also delegate with `subagent`/`subagent_fork`.

The `todo_write` task tracker is opt-in and not in the shipped config: add `@deepseek-ai/dsh-tool-todo` to `cordis.yml` (or a personal-config overlay under `~/.dsh`) to expose it. Once loaded, the model records a whole-list plan to the session log and the TUI renders it.

The TUI renders Markdown history, reasoning, tool-owned terminal/diff/generic cards, token totals, and — when `todo_write` is loaded — the latest plan. Long tool bodies keep a head/tail preview; Ctrl+O expands or collapses every card. Enter submits or steers while the agent runs, Ctrl+R toggles reasoning, Escape cancels, and `/help` lists commands. `/plan` selects plan mode for the next step; `/plan <message>` also submits the message into that step, while `/plan off` selects the default mode without model input. `/status` expands the current session's identity, activity counts, exact token/cache buckets, context use, and timestamps without interrupting a running turn. `/model` opens a keyboard selector for the current provider catalog; use Up/Down and Enter, or `/model <model>` and `/model <provider>/<model>` for direct selection. `ask_user_question` opens a wide bottom-left keyboard panel with batch progress and numbered options.

### Resuming a prior session

Each run starts a fresh session by default (its event log lands under `./.sessions/`). To **continue** a previous conversation, pass its id to the installed `dsh` CLI — the `main` agent then rehydrates the persisted log instead of starting fresh, so the model sees the earlier turns as history:

```sh
dsh --resume <prior-session-id>
```

`/resume` opens a searchable keyboard selector with titles, activity, last-turn results, model route, durable goal phase, and live/persisted state. The installed `dsh` host flushes and disposes the current app, then replaces the process with `dsh --resume <id>`. The TUI still prints that command on exit and shows it when a custom host cannot hand off. `dsh --resume <id>` provides the id on the boot context, which `cordis.yml` reads (`resumeSessionId: !!js "typeof resumeSessionId === 'string' ? resumeSessionId : undefined"`); with no flag the agent starts a new session. A missing or unreadable id starts no agent and emits `agent-loop/config-start-failed`: the TUI prints the failure and exits nonzero. The selector has no cross-process session lock, so deployments with concurrent hosts must coordinate session ownership separately.

## Code Mode

[`code-mode.cordis.yml`](code-mode.cordis.yml) overlays the same tree with the worker-thread runtime and `tools: { mode: code }`. The model receives one `run_code` transport plus a generated TypeScript SDK for the visible tools; only program output returns to model context. Use `mode: both` to expose native calls alongside `run_code`. See the [Code Mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md) for the execution contract.

```sh
pnpm run demo:code-mode        # this overlay under the TUI (default UI)
pnpm run demo:code-mode acp    # the acp-agent example's same-shaped overlay
```

Try a task that spans several tool calls, e.g.:

> Count the lines of every `*.md` file under docs/ and write the three largest to summary.txt.

and watch the transcript: one `run_code` call, a program looping over tools, and a result the model curated instead of five round-trips of raw tool output.

## What each leaf entry demonstrates

This example is a thin leaf `cordis.yml`: it picks the swappable backends, loads one app package, and adds product tools that are intentionally outside the shared spine. The spine (sessions, system-prompt, tools, agents, invariants, `agent-loop`) and the front-door cluster (JSONL persistence, the pi-tui channel, the pre-created `main` agent) live inside the [`@deepseek-ai/dsh-tui-demo`](../../packages/examples/tui-demo) app and the [`@deepseek-ai/dsh-agent-spine-demo`](../../packages/examples/agent-spine-demo) bundle it loads; the leaf wires the backends and model-facing optional tools:

| Entry | Demonstrates |
|---|---|
| `hmr` (`@cordisjs/plugin-hmr`) | the dev/demo edit-reload loop — a **leaf** entry (not baked into the app) because it depends on the Loader's internal module access |
| `llm-deepseek` | real `LlmAdapter` via config (`!!js process.env.…` secrets); swap one line to `@deepseek-ai/dsh-llm-pi-ai` for the library-backed twin |
| `bash` (`dsh-bash-local`) | the executor implementation — the swappable half of the bash seam. The model-facing `bash` schema (`tool-bash`) and generic `task_*` controls (`tool-tasks`) come from `dsh-agent-spine-demo`, so only the executor is a leaf choice |
| `tui-agent` (`@deepseek-ai/dsh-tui-demo`) | the app bundle: the agent-spine demo + JSONL persistence + the pi-tui channel + a pre-created `main` agent |
| `subagent`, `subagent-spawn`, `subagent-fork` | the subagent provider registry plus the two in-process backends: a fresh child and a child seeded with the parent's completed-turn prefix |
| `tool-subagent`, `tool-subagent-fork` | two model-facing `dsh-tool-subagent` loads, each bound to a different provider and exposed under a distinct tool name (`subagent`, `subagent_fork`) |
| `workflow-workerthread`, `tool-workflow` | the worker-thread workflow engine and its model-facing `workflow` tool, with child calls routed through the spawn backend |
| `plan-mode` | the plugin-owned `/plan [message]` entry and `/plan off` exit commands, plan-mode prompt policy, tool restrictions, and reviewed `exit_plan_mode` transition |
| `fs-local`, `fs-policy`, `tool-fs` | the filesystem stack: the local `ctx.fs` provider, the read-before-write/edit policy gate (on the `fs/*` event gate), and the model-facing `read`/`write`/`edit` tools. Relative paths resolve against the session workspace |

## End-to-end tests (`pnpm run test:e2e`)

The UI-independent with-key suites assemble the full stack programmatically through `tests/harness.ts` (no PTY, no Loader):

- `tests/full-loop.e2e.ts` — the canary: real model runs `echo e2e-ok` through the real bash tool; asserts `tool/call`/`tool/result` session events and the final answer.
- `tests/coding-task.e2e.ts` — the swebench-style smoke: a temp dir holds `add.js` (with `a - b` where `a + b` belongs) and a failing `add.test.js`; the agent must fix the bug and verify. The test re-runs `node add.test.js` ITSELF and inspects the files — agent claims are not trusted.
- `tests/resume.e2e.ts` — durable continuity across processes: run 1 tells the real model a secret code and persists the turn to a temp JSONL root, then the whole context is disposed; run 2 is a fresh context over the same root that RESUMES the session id and asks the model to recall the code. The recall can only come from the rehydrated log.
- `tests/compaction.e2e.ts` — the compaction smoke: a real multi-step bash task runs with a deliberately tiny context window so the auto-compaction listener fires MID-SESSION. Verifies the WORLD — a `compact/start…end` pair landed in the real log, the surface shrank (a replace node shadowed older nodes), and the agent still produced a correct final answer after compaction.
- `tests/todo-write.e2e.ts` — loads the opt-in `todo_write` tool, then a real model drives it and the test verifies the resulting `todo/write` session event.
- `tests/code-mode.e2e.ts` — the with-key Code Mode proof: a real model, a two-tool task, asserting the wire tool list was exactly `[run_code]`, the `tool/code-dispatch` events landed under the parent call, and the curated answer came back.

These self-skip without `DEEPSEEK_API_KEY`. The keyless `tests/tui-keyless-smoke.e2e.ts` boots the real Loader tree in a PTY (the one sanctioned PTY surface): the base boot + `/plan` + `/exit`, a scripted-LLM conversation with a question dialog and tool round-trip, the Code Mode overlay welcome line, and the resume-failure exit path.

## Snapshot tests

`tests/snapshots/<scenario>/session.jsonl` supplies recorded user prompts and model chunks; sibling child logs drive subagents and workflows. The keyless suite executes those scripts through the real loop and tool implementations, then compares readable expected terminal cell/style output. Use `pnpm run test:snapshot:refresh` for presentation-only changes and `pnpm run test:snapshot:record` with a DeepSeek key when a recorded model journey changes. The implemented [TUI snapshot Agent Note](../../.agents/notes/implemented/testing/2026-07-18-tui-terminal-state-snapshots.md) owns the scenario matrix and the split between recorded journeys, transient package snapshots, and PTY coverage.
