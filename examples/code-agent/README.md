# code-agent — the Code Mode demo

The [Code Mode](../../docs/rfc/implemented/feature/2026-06-15-code-mode.md) form of the coding agent: instead of one native tool call per step, the model is offered exactly ONE wire tool — `run_code` — plus a generated TypeScript SDK section declaring every other registered tool (`bash`, `read`, `write`, `edit`, `todo_write`). The model composes tools by writing a program; the program runs in a fresh worker thread (`@deepseek-ai/dsh-code-runtime-worker`), its tool calls bridge back through the ordinary `tools/pre-execute`/`post-execute` pipeline one at a time, each is logged as a `tool/code-dispatch` session event, and ONLY what the program prints or returns re-enters the model's context.

```sh
pnpm run demo:code        # needs DEEPSEEK_API_KEY (repo-root .env works)
```

Try a task that spans several tool calls, e.g.:

> Count the lines of every `*.md` file under docs/ and write the three largest to summary.txt.

and watch the transcript: one `run_code` call, a program looping over tools, and a result the model curated instead of five round-trips of raw tool output.

Two lines of `cordis.yml` make the difference from [examples/coding-agent](../coding-agent/README.md): the `code-runtime` entry (the worker-thread backend registering `ctx.codeRuntime`) and `tools: { mode: code }` on the app (flip it to `both` to offer native calls AND `run_code` side by side; remove both lines and it IS the coding agent).

Tests: `tests/keyless-smoke.e2e.ts` boots the real `cordis.yml` through the Loader with no prompt (the export-shape guard); `tests/code-mode.e2e.ts` is the with-key proof — a real model, a two-tool task, asserting the wire tool list was exactly `[run_code]`, the `tool/code-dispatch` events landed, and the curated answer came back.
