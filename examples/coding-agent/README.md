# coding-agent

The first REAL agent wiring: DeepSeek V4 + the bash tool suite + stdio chat
+ JSONL persistence, loaded from `cordis.yml`. Where echo-agent proves the skeleton with mocks, this example is a usable coding assistant.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
yarn demo:coding
```

Type a coding task. The agent's only tools are `bash` (+ `bash_output` / `bash_kill` for background tasks): file reads, writes, searches, and test runs all happen through shell commands, each in a fresh `bash -c` (the system prompt tells the model to pass `workdir` instead of `cd`). Reasoning streams dimmed; tool calls/results render inline.

```
> fix the failing test in /path/to/project
[main turn 1] (reasoning…)
  [tool call] bash({"command": "node --test", "workdir": "/path/to/project"})
  [tool result] … [exit code: 1]
  …
```

## What each plugin demonstrates

| Entry | Demonstrates |
|---|---|
| `llm-deepseek` | real `LlmAdapter` via config (`!!js process.env.…` secrets); swap one line to `@deepseek-ai/dsh-llm-pi-ai` for the library-backed twin |
| `bash` (`dsh-bash-local`) + `tool-bash` | the executor seam + tool schemas as separate plugins |
| `agent-loop` | agent created from config with a coding system prompt |
| `src/session-jsonl.ts` | write-behind persistence on `session/event` + `session/flush` (copied from echo-agent) |
| `src/stdio-chat.ts` | UI as a plugin; copied from echo-agent with reasoning-dimming and an exit-on-idle close handler for piped stdin. Example-local on purpose — extract a shared UI package when a third example needs it |

## End-to-end tests (`yarn test:e2e`, key-gated)

- `tests/full-loop.e2e.ts` — the canary: real model runs `echo e2e-ok` through the real bash tool; asserts `tool/call`/`tool/result` session events and the final answer.
- `tests/coding-task.e2e.ts` — the swebench-style smoke: a temp dir holds `add.js` (with `a - b` where `a + b` belongs) and a failing `add.test.js`; the agent must fix the bug and verify. The test re-runs `node add.test.js` ITSELF and inspects the files — agent claims are not trusted.

Both self-skip without `DEEPSEEK_API_KEY`.
