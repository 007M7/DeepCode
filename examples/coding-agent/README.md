# coding-agent

The real stdio coding-agent wiring: DeepSeek V4 + the `read`/`write`/`edit` filesystem tools + the bash tool suite + subagent delegation + `todo_write` + stdio chat + JSONL persistence, loaded from `cordis.yml`. Where echo-agent proves the skeleton with mocks, this example is a usable coding assistant.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:coding
```

Type a coding task. The agent works through the `read`/`write`/`edit` filesystem tools for ordinary file operations and `bash` (+ `bash_output` / `bash_kill` for background tasks) for shell commands, searches, and test runs, each in a fresh `bash -c` (the system prompt tells the model to pass `workdir` instead of `cd`). Both the fs tools and bash resolve relative paths against the session workspace. It can also delegate with `subagent`/`subagent_fork` and track multi-step work with `todo_write` (a whole-list task tracker rendered as a checklist). Reasoning streams dimmed; tool calls/results render inline.

```
> fix the failing test in /path/to/project
[main turn 1] (reasoning…)
  [tool call] bash({"command": "node --test", "workdir": "/path/to/project"})
  [tool result] … [exit code: 1]
  …
```

### Resuming a prior session

Each run starts a fresh session by default (its event log lands under `./.sessions/`). To **continue** a previous conversation, set `RESUME_SESSION_ID` to that session's id — the `main` agent then rehydrates the persisted log instead of starting fresh, so the model sees the earlier turns as history:

```sh
RESUME_SESSION_ID=<prior-session-id> pnpm run demo:coding
```

The id is wired through `cordis.yml` (`resumeSessionId: !!js process.env.RESUME_SESSION_ID`); unset, the agent starts a new session. A missing/unreadable id is non-fatal — it logs a warning and starts no `main` agent.

## What each leaf entry demonstrates

This example is a thin leaf `cordis.yml`: it picks the swappable backends, loads one app package, and adds product tools that are intentionally outside the shared spine. The spine (sessions, system-prompt, tools, agents, invariants, `agent-loop`) and the front-door cluster (console logger, JSONL persistence, readline UI, the pre-created `main` agent) live inside the [`@deepseek-ai/dsh-stdio-agent`](../../packages/ui/stdio-agent) app and the [`@deepseek-ai/dsh-agent-core`](../../packages/core/agent-core) bundle it loads; the leaf wires the backends and model-facing optional tools:

| Entry | Demonstrates |
|---|---|
| `hmr` (`@cordisjs/plugin-hmr`) | the dev/demo edit-reload loop — a **leaf** entry (not baked into the app) because it is Loader-only and needs `node --expose-internals`, which `demo:coding` passes |
| `llm-deepseek` | real `LlmAdapter` via config (`!!js process.env.…` secrets); swap one line to `@deepseek-ai/dsh-llm-pi-ai` for the library-backed twin |
| `bash` (`dsh-bash-local`) | the executor implementation — the swappable half of the bash seam. The model-facing `bash`/`bash_output`/`bash_kill` tool schemas (`tool-bash`) come from `agent-core`, so only the executor is a leaf choice |
| `stdio-agent` (`@deepseek-ai/dsh-stdio-agent`) | the app bundle: the agent-core spine + console logger + JSONL persistence + readline UI + a pre-created `main` agent. Its config carries the model, system prompt, `persistenceRoot` (`./.sessions`), and `resumeSessionId` — so persistence and the agent are configured here, not wired as separate leaf plugins |
| `subagent`, `subagent-spawn`, `subagent-fork` | the subagent provider registry plus the two in-process backends: a fresh child and a child seeded with the parent's completed-turn prefix |
| `tool-subagent`, `tool-subagent-fork` | two model-facing `dsh-tool-subagent` loads, each bound to a different provider and exposed under a distinct tool name (`subagent`, `subagent_fork`) |
| `tool-todo` | the model-facing `todo_write` tool; writes the whole task list to the session log and renders as a checklist in stdio |
| `fs-local`, `fs-policy`, `tool-fs` | the filesystem stack: the local `ctx.fs` provider, the read-before-write/edit policy gate (on the `fs/*` event gate), and the model-facing `read`/`write`/`edit` tools. Relative paths resolve against the session workspace |

## End-to-end tests (`pnpm run test:e2e`, key-gated)

- `tests/full-loop.e2e.ts` — the canary: real model runs `echo e2e-ok` through the real bash tool; asserts `tool/call`/`tool/result` session events and the final answer.
- `tests/coding-task.e2e.ts` — the swebench-style smoke: a temp dir holds `add.js` (with `a - b` where `a + b` belongs) and a failing `add.test.js`; the agent must fix the bug and verify. The test re-runs `node add.test.js` ITSELF and inspects the files — agent claims are not trusted.
- `tests/resume.e2e.ts` — durable continuity across processes: run 1 tells the real model a secret code and persists the turn to a temp JSONL root, then the whole context is disposed; run 2 is a fresh context over the same root that RESUMES the session id and asks the model to recall the code. The recall can only come from the rehydrated log.
- `tests/compaction.e2e.ts` — the compaction smoke: a real multi-step bash task runs with a deliberately tiny context window so the auto-compaction listener fires MID-SESSION. Verifies the WORLD — a `compact/start…end` pair landed in the real log, the surface shrank (a replace node shadowed older nodes), and the agent still produced a correct final answer after compaction.
- `tests/todo-write.e2e.ts` — a real model drives the real `todo_write` tool and the test verifies the resulting `todo/write` session event.

These self-skip without `DEEPSEEK_API_KEY`. The keyless boot smoke is `tests/keyless-smoke.e2e.ts` (boots the full real tree with a dummy key and no prompt, so no model call), which runs in the default e2e gate.
