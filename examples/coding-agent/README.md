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

## What each plugin demonstrates

| Entry | Demonstrates |
|---|---|
| `llm-deepseek` | real `LlmAdapter` via config (`!!js process.env.…` secrets); swap one line to `@deepseek-ai/dsh-llm-pi-ai` for the library-backed twin |
| `bash` (`dsh-bash-local`) + `tool-bash` | the executor seam + tool schemas as separate plugins |
| `agent-loop` | agent created from config with a coding system prompt |
| `session-persistence` (`dsh-session-persistence-jsonl`) | durable JSONL persistence (`root: ./.sessions`): append-only event log per session, crash-safe atomic writes — the shared backend, no per-example file |
| `src/stdio-chat.ts` | UI as a plugin; copied from echo-agent with reasoning-dimming and an exit-on-idle close handler for piped stdin. Example-local on purpose — extract a shared UI package when a third example needs it |

## End-to-end tests (`pnpm run test:e2e`, key-gated)

- `tests/full-loop.e2e.ts` — the canary: real model runs `echo e2e-ok` through the real bash tool; asserts `tool/call`/`tool/result` session events and the final answer.
- `tests/coding-task.e2e.ts` — the swebench-style smoke: a temp dir holds `add.js` (with `a - b` where `a + b` belongs) and a failing `add.test.js`; the agent must fix the bug and verify. The test re-runs `node add.test.js` ITSELF and inspects the files — agent claims are not trusted.
- `tests/resume.e2e.ts` — durable continuity across processes: run 1 tells the real model a secret code and persists the turn to a temp JSONL root, then the whole context is disposed; run 2 is a fresh context over the same root that RESUMES the session id and asks the model to recall the code. The recall can only come from the rehydrated log.

Both self-skip without `DEEPSEEK_API_KEY`.
