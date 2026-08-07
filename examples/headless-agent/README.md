# headless-agent

English | [中文](README.zh.md)

Headless one-shot agent wiring: DeepSeek V4 + local bash and filesystem tools + subagent delegation + workflows and fresh-agent Ralph iteration + `todo_write` + JSONL persistence, with [`@deepseek-ai/dsh-cli-demo`](../../packages/examples/cli-demo) as the app front door.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:headless "fix the failing test in this workspace"
pnpm run demo:headless --output-format json -- "summarize the implementation"
pnpm run demo:headless --output-format stream-json -- "run the focused tests"
```

Exactly one nonblank positional task is required; quote tasks containing spaces. There is no `-p` flag. `text` prints the last text-bearing assistant message, `json` prints one DSH-native result record, and `stream-json` emits the top-level session's canonical task-turn events before that record. Child sessions surface only through parent tool events and results.

Each invocation creates and persists a fresh session, runs all model and tool steps in one turn, flushes, disposes, and exits. This is non-interactive automation: there is no prompt, approval, resume, second turn, or stdin context. The configured tools can mutate the launch workspace, run commands, spawn child agents, and consume provider tokens.

## Advanced configuration

[`advanced.cordis.yml`](advanced.cordis.yml) adds Code Mode and the Cordis tools to the shipped leaf.

The package-level [CLI contract](../../packages/examples/cli-demo/README.md) documents output records, exit status, cancellation, persistence, and model/token effects.
