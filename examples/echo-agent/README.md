# echo-agent

Runnable demo: stdin chat with a scripted mock model and an echo tool. The all-mock skeleton — "swap the backend, keep the app".

## What it shows

This example is just a leaf `cordis.yml`: it loads the [`@deepseek-ai/dsh-stdio-demo`](../../packages/examples/stdio-demo) app (which bundles the whole [`@deepseek-ai/dsh-agent-spine-demo`](../../packages/examples/agent-spine-demo) spine, the console logger, JSONL persistence, the readline UI, and a pre-created `main` agent), and swaps in two example-local backends plus `hmr`:

- `mock-llm.ts` — a mock `LlmAdapter` that streams scripted responses and calls the `echo` tool when the user types "echo <something>". Registered with `ctx.llm.registerAdapter(['mock-echo'], …)`.
- `echo-tool.ts` — a tool registered via `ctx.tools.register(defineTool(…))` with typed `execute` args; echoes text back uppercased.

Swapping `mock-llm` for the real `llm-deepseek` adapter is all that separates this from `coding-agent` — the same app, a different backend.

## Plugin files

| File | Role | Key patterns demonstrated |
|---|---|---|
| `src/mock-llm.ts` | `LlmAdapter` registration | `ctx.llm.registerAdapter(['mock-echo'], …)`, streaming chunks with the proper `block-start`/`block-end` protocol |
| `src/echo-tool.ts` | Tool registration | `ctx.tools.register(defineTool(…))` with typed `execute` args, returning `ContentBlock[]` |
| `cordis.yml` | Leaf wiring | the two backends + `hmr` + one `@deepseek-ai/dsh-stdio-demo` entry carrying the app config |

The spine, UI, persistence, and boot glue all live in `@deepseek-ai/dsh-stdio-demo` and the bundle it loads — this folder holds only the demo-specific mocks and the leaf wiring.

## Run

```sh
pnpm run demo:echo
# or:
node --expose-internals --import tsx packages/examples/stdio-demo/src/bin.ts examples/echo-agent/cordis.yml
```

Type a message and press Enter. "echo <text>" triggers a tool call round-trip (the mock model requests the `echo` tool, which echoes the text uppercased, and the next model step acknowledges it).

The session is persisted under `.sessions/` relative to the directory you launch the demo from. `pnpm run demo:echo` runs from the repo root, so the logs land in `<repo-root>/.sessions/cwd-<hash>/` (one `.jsonl` log per session). Clean up with: `rm -rf .sessions`
