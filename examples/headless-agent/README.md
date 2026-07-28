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

## E2B POC overlay

[`e2b.cordis.yml`](e2b.cordis.yml) replaces the local filesystem and subprocess providers with one shared E2B sandbox while retaining `dsh-bash-local` and the same model-facing tools. Put `E2B_API_KEY` beside `DEEPSEEK_API_KEY` in the gitignored root `.env`, then run:

```sh
pnpm run demo:e2b "create hello.txt, read it back, and run pwd"
```

The overlay creates the same absolute cwd inside the sandbox, but it does not upload or mount the host workspace. File and Bash mutations exist only in E2B; Cordis, model calls, agent/session state, session logs, skills, and SDK buffers remain on the host. The demo kills its sandbox on timeout and disposal. It is a provider-composition POC, not a whole-harness migration or a workspace-sync feature.

## Advanced and snapshot wiring

[`advanced.cordis.yml`](advanced.cordis.yml) adds Code Mode and the Cordis tools to the shipped leaf. [`advanced.cordis.snapshot.yml`](advanced.cordis.snapshot.yml) replaces only the live LLM with replay. The tests under [`tests/`](tests/) own the keyless real-Loader smoke, key-gated world-verified smoke, and the `stream-json` replay snapshot with its parent and child session fixtures.

The package-level [CLI contract](../../packages/examples/cli-demo/README.md) documents output records, exit status, cancellation, persistence, and model/token effects.
