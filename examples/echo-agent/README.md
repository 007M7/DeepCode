# echo-agent

Network-free Headless demo with a scripted mock model and an echo tool.

## What it shows

The leaf loads [`@deepseek-ai/dsh-cli-demo`](../../packages/examples/cli-demo), which supplies the shared spine, JSONL persistence, one fresh `main` agent, and the one-shot CLI driver. Two local plugins provide the demo behavior:

- `mock-llm.ts` registers a scripted `LlmAdapter`; a task beginning with `echo ` requests the tool.
- `echo-tool.ts` registers a typed tool that returns the input uppercased.

| File | Role |
|---|---|
| `src/mock-llm.ts` | Streaming mock adapter |
| `src/echo-tool.ts` | Model-facing echo tool |
| `cordis.yml` | Mock plugins, local providers, and one `@deepseek-ai/dsh-cli-demo` entry |

## Run

```sh
pnpm run demo:echo "echo hello world"
pnpm run demo:echo --output-format stream-json -- "echo hello world"
```

The first command prints the final canned response. `stream-json` also exposes the canonical `tool/call` and `tool/result` events. Sessions persist under `.sessions/` relative to the launch directory; remove that generated directory when finished.
