# coding-agent

The coding-agent REPL wiring: DeepSeek V4 + the `read`/`write`/`edit` filesystem tools + the bash tool suite + subagent delegation + `todo_write` + readline chat + JSONL persistence, loaded from `cordis.yml`. The sibling [`tui-agent`](../tui-agent/README.md) fixes the same agent composition to the full-screen terminal front door.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:repl
```

Type a coding task. The agent works through the `read`/`write`/`edit` filesystem tools for ordinary file operations and `bash` (+ the generic `task_output` / `task_list` / `task_kill` for background tasks) for shell commands, searches, and test runs, each in a fresh `bash -c` (the system prompt tells the model to pass `workdir` instead of `cd`). Both the fs tools and bash resolve relative paths against the session workspace. It can also delegate with `subagent`/`subagent_fork` and track multi-step work with `todo_write`.

The REPL renders reasoning, tool calls/results, and the latest todo list as line-oriented output suitable for terminals and pipes. Use `pnpm run demo:tui` for the interactive Markdown/card interface.

### Resuming a prior session

Each run starts a fresh session by default (its event log lands under `./.sessions/`). To **continue** a previous conversation, set `RESUME_SESSION_ID` to that session's id — the `main` agent then rehydrates the persisted log instead of starting fresh, so the model sees the earlier turns as history:

```sh
RESUME_SESSION_ID=<prior-session-id> pnpm run demo:repl
```

The id is wired through `cordis.yml` (`resumeSessionId: !!js process.env.RESUME_SESSION_ID`); unset, the agent starts a new session. A missing or unreadable id starts no agent and emits `agent-loop/config-start-failed`: the TUI prints the failure and exits nonzero, while readline reports any dropped queued input and allows piped EOF to finish. Unset it or choose an existing session id.

## Code Mode

[`code-mode.cordis.yml`](code-mode.cordis.yml) overlays the same tree with the worker-thread runtime and `tools: { mode: code }`. The model receives one `run_code` transport plus a generated TypeScript SDK for the visible tools; only program output returns to model context. Use `mode: both` to expose native calls alongside `run_code`. See the [Code Mode RFC](../../docs/rfc/implemented/feature/2026-06-15-code-mode.md) for the execution contract.

```sh
pnpm run demo:code-mode        # this overlay under the REPL (default UI)
pnpm run demo:code-mode acp    # the acp-agent example's same-shaped overlay
```

Try a task that spans several tool calls, e.g.:

> Count the lines of every `*.md` file under docs/ and write the three largest to summary.txt.

and watch the transcript: one `run_code` call, a program looping over tools, and a result the model curated instead of five round-trips of raw tool output.

## What each leaf entry demonstrates

This example is a thin leaf `cordis.yml`: it picks the swappable backends, loads one app package, and adds product tools that are intentionally outside the shared spine. The spine (sessions, system-prompt, tools, agents, invariants, `agent-loop`) and the front-door cluster (JSONL persistence, the selected terminal channel, the pre-created `main` agent) live inside the [`@deepseek-ai/dsh-stdio-demo`](../../packages/examples/stdio-demo) app and the [`@deepseek-ai/dsh-agent-spine-demo`](../../packages/examples/agent-spine-demo) bundle it loads; the leaf wires the backends and model-facing optional tools:

| Entry | Demonstrates |
|---|---|
| `hmr` (`@cordisjs/plugin-hmr`) | the dev/demo edit-reload loop — a **leaf** entry (not baked into the app) because it is Loader-only and needs `node --expose-internals`, which `demo:repl` passes |
| `llm-deepseek` | real `LlmAdapter` via config (`!!js process.env.…` secrets); swap one line to `@deepseek-ai/dsh-llm-pi-ai` for the library-backed twin |
| `bash` (`dsh-bash-local`) | the executor implementation — the swappable half of the bash seam. The model-facing `bash` schema (`tool-bash`) and generic `task_*` controls (`tool-tasks`) come from `dsh-agent-spine-demo`, so only the executor is a leaf choice |
| `stdio-agent` (`@deepseek-ai/dsh-stdio-demo`) | the app bundle: the agent-spine demo + JSONL persistence + the configured terminal channel + a pre-created `main` agent. This leaf fixes `ui.mode` to `readline`; `tui-agent` owns the corresponding TUI leaf |
| `subagent`, `subagent-spawn`, `subagent-fork` | the subagent provider registry plus the two in-process backends: a fresh child and a child seeded with the parent's completed-turn prefix |
| `tool-subagent`, `tool-subagent-fork` | two model-facing `dsh-tool-subagent` loads, each bound to a different provider and exposed under a distinct tool name (`subagent`, `subagent_fork`) |
| `tool-todo` | the model-facing `todo_write` tool; writes the whole task list to the session log and renders as a persistent TUI plan or readline checklist |
| `fs-local`, `fs-policy`, `tool-fs` | the filesystem stack: the local `ctx.fs` provider, the read-before-write/edit policy gate (on the `fs/*` event gate), and the model-facing `read`/`write`/`edit` tools. Relative paths resolve against the session workspace |

## End-to-end tests (`pnpm run test:e2e`, key-gated)

- `tests/full-loop.e2e.ts` — the canary: real model runs `echo e2e-ok` through the real bash tool; asserts `tool/call`/`tool/result` session events and the final answer.
- `tests/coding-task.e2e.ts` — the swebench-style smoke: a temp dir holds `add.js` (with `a - b` where `a + b` belongs) and a failing `add.test.js`; the agent must fix the bug and verify. The test re-runs `node add.test.js` ITSELF and inspects the files — agent claims are not trusted.
- `tests/resume.e2e.ts` — durable continuity across processes: run 1 tells the real model a secret code and persists the turn to a temp JSONL root, then the whole context is disposed; run 2 is a fresh context over the same root that RESUMES the session id and asks the model to recall the code. The recall can only come from the rehydrated log.
- `tests/compaction.e2e.ts` — the compaction smoke: a real multi-step bash task runs with a deliberately tiny context window so the auto-compaction listener fires MID-SESSION. Verifies the WORLD — a `compact/start…end` pair landed in the real log, the surface shrank (a replace node shadowed older nodes), and the agent still produced a correct final answer after compaction.
- `tests/todo-write.e2e.ts` — a real model drives the real `todo_write` tool and the test verifies the resulting `todo/write` session event.

These self-skip without `DEEPSEEK_API_KEY`. `tests/code-mode.e2e.ts` is the with-key Code Mode proof — a real model, a two-tool task, asserting the wire tool list was exactly `[run_code]`, the `tool/code-dispatch` events landed under the parent call, and the curated answer came back. The keyless boot smokes run in the default e2e gate: `tests/keyless-smoke.e2e.ts` (the full real tree, dummy key, no prompt → no model call) and `tests/code-mode-keyless-smoke.e2e.ts` (the same guard for the Code Mode overlay).
