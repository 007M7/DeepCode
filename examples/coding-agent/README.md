# coding-agent

The first REAL agent wiring: DeepSeek V4 + the bash tool suite + stdio chat
+ JSONL persistence, loaded from `cordis.yml`. Where echo-agent proves the skeleton with mocks, this example is a usable coding assistant.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:coding
```

Type a coding task. The agent's only tools are `bash` (+ `bash_output` / `bash_kill` for background tasks): file reads, writes, searches, and test runs all happen through shell commands, each in a fresh `bash -c` (the system prompt tells the model to pass `workdir` instead of `cd`). Reasoning streams dimmed; tool calls/results render inline.

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

This example is a thin leaf `cordis.yml`: it picks the swappable backends and loads one app package. The spine (sessions, system-prompt, tools, agents, invariants, `agent-loop`) and the front-door cluster (console logger, JSONL persistence, readline UI, the pre-created `main` agent) all live inside the [`@deepseek-ai/dsh-stdio-agent`](../../packages/ui/stdio-agent) app and the [`@deepseek-ai/dsh-agent-core`](../../packages/core/agent-core) bundle it loads — so the leaf has only four entries:

| Entry | Demonstrates |
|---|---|
| `hmr` (`@cordisjs/plugin-hmr`) | the dev/demo edit-reload loop — a **leaf** entry (not baked into the app) because it is Loader-only and needs `node --expose-internals`, which `demo:coding` passes |
| `llm-deepseek` | real `LlmAdapter` via config (`!!js process.env.…` secrets); swap one line to `@deepseek-ai/dsh-llm-pi-ai` for the library-backed twin |
| `bash` (`dsh-bash-local`) | the executor implementation — the swappable half of the bash seam. The model-facing `bash`/`bash_output`/`bash_kill` tool schemas (`tool-bash`) come from `agent-core`, so only the executor is a leaf choice |
| `stdio-agent` (`@deepseek-ai/dsh-stdio-agent`) | the app bundle: the agent-core spine + console logger + JSONL persistence + readline UI + a pre-created `main` agent. Its config carries the model, system prompt, `persistenceRoot` (`./.sessions`), and `resumeSessionId` — so persistence and the agent are configured here, not wired as separate leaf plugins |

## End-to-end tests (`pnpm run test:e2e`, key-gated)

- `tests/full-loop.e2e.ts` — the canary: real model runs `echo e2e-ok` through the real bash tool; asserts `tool/call`/`tool/result` session events and the final answer.
- `tests/coding-task.e2e.ts` — the swebench-style smoke: a temp dir holds `add.js` (with `a - b` where `a + b` belongs) and a failing `add.test.js`; the agent must fix the bug and verify. The test re-runs `node add.test.js` ITSELF and inspects the files — agent claims are not trusted.
- `tests/resume.e2e.ts` — durable continuity across processes: run 1 tells the real model a secret code and persists the turn to a temp JSONL root, then the whole context is disposed; run 2 is a fresh context over the same root that RESUMES the session id and asks the model to recall the code. The recall can only come from the rehydrated log.

Both self-skip without `DEEPSEEK_API_KEY`.
