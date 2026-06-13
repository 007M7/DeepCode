# echo-agent

Runnable demo: stdin chat with a scripted mock model and an echo tool.

## What it shows

- A complete Cordis app loaded from `cordis.yml` — the standard "stack of plugins" pattern
- `mock-llm.ts` — a mock `LlmAdapter` that streams scripted responses and calls the `echo` tool when the user types "echo <something>"
- `echo-tool.ts` — a tool registered via `ctx.tools.register()` that echoes text back uppercased
- `session-jsonl.ts` — a minimal persistence plugin: write-behind buffering of `session/event` notifications, drained to a JSONL file at `session/flush`
- `stdio-chat.ts` — a minimal UI plugin: reads stdin lines and `send`/`steer`s the agent, renders stream deltas, tool calls, and tool results

## Plugin files

| File | Role | Key patterns demonstrated |
|---|---|---|
| `mock-llm.ts` | `LlmAdapter` registration | `ctx.llm.registerAdapter(['mock-echo'], …)`, streaming chunks with proper `block-start`/`block-end` protocol |
| `echo-tool.ts` | Tool registration | `ctx.tools.register(defineTool(…))` with typed `execute` args, tool execution returning `ContentBlock[]` |
| `session-jsonl.ts` | Persistence | `session/event` listener + `session/flush` drain, fiber-dispose cleanup |
| `stdio-chat.ts` | UI | `agent/stream-chunk`, `session/event` (tool/*), stdin→send/steer |
| `start.ts` | Bootstrap | `Context` + `Loader` + `plugin-include` wired to `cordis.yml` |

## Run

```sh
yarn demo
# or:
node --expose-internals --import tsx examples/echo-agent/start.ts
```

Type a message and press Enter. "echo <text>" triggers a tool call round-trip (the mock model requests the `echo` tool, which echoes the text uppercased, and the next model step acknowledges it).

The session is persisted to `<session-id>.jsonl` in the `examples/echo-agent/` directory. Clean up with: `rm -f examples/echo-agent/*.jsonl`
