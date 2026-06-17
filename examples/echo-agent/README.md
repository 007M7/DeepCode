# echo-agent

Runnable demo: stdin chat with a scripted mock model and an echo tool.

## What it shows

- A complete Cordis app loaded from `cordis.yml` — the standard "stack of plugins" pattern
- `mock-llm.ts` — a mock `LlmAdapter` that streams scripted responses and calls the `echo` tool when the user types "echo <something>"
- `echo-tool.ts` — a tool registered via `ctx.tools.register()` that echoes text back uppercased
- `@deepseek-ai/dsh-session-persistence-jsonl` — the durable JSONL persistence backend (loaded from `cordis.yml`, `root: ./.sessions`): append-only event log per session with crash-safe atomic writes, replacing the old write-only example plugin
- `stdio-chat.ts` — a minimal UI plugin: reads stdin lines and `send`/`steer`s the agent, renders stream deltas, tool calls, and tool results

## Plugin files

| File | Role | Key patterns demonstrated |
|---|---|---|
| `mock-llm.ts` | `LlmAdapter` registration | `ctx.llm.registerAdapter(['mock-echo'], …)`, streaming chunks with proper `block-start`/`block-end` protocol |
| `echo-tool.ts` | Tool registration | `ctx.tools.register(defineTool(…))` with typed `execute` args, tool execution returning `ContentBlock[]` |
| `stdio-chat.ts` | UI | `agent/stream-chunk`, `session/event` (tool/*), stdin→send/steer |
| `start.ts` | Bootstrap | `Context` + `Loader` + `plugin-include` wired to `cordis.yml` |

Persistence is the shared `@deepseek-ai/dsh-session-persistence-jsonl` plugin (not a per-example file).

## Run

```sh
pnpm run demo:echo
# or:
node --expose-internals --import tsx examples/echo-agent/start.ts
```

Type a message and press Enter. "echo <text>" triggers a tool call round-trip (the mock model requests the `echo` tool, which echoes the text uppercased, and the next model step acknowledges it).

The session is persisted under `.sessions/` relative to the directory you launch the demo from. `pnpm run demo:echo` runs from the repo root, so the logs land in `<repo-root>/.sessions/` (a session with no cwd goes in the `_no-cwd/` bucket, one `.jsonl` log per session). Clean up with: `rm -rf .sessions`
