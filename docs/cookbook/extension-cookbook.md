# Cookbook: extension plugin shapes

The three plugin shapes you write against the harness extension surface, as illustrative snippets (elided imports and helper stubs — not copy-paste-complete). For the full step-by-step guides see [adding a package](./adding-a-package.md), [adding a tool](./adding-a-tool.md), and [adding an LLM adapter](./adding-an-llm-adapter.md); for the seams these hook into see [docs/architecture.md](../architecture.md).

## A tool plugin

A tool registers on `ctx.tools`. The annotated `defineTool` example (typed `execute` args, result shaping, the `run_in_background` pattern) lives in [adding-a-tool.md](./adding-a-tool.md) — that guide is the source of truth for the tool shape. Raw JSON-Schema `ToolDefinition`s are also accepted by `ctx.tools.register()` directly (that is how MCP-sourced tools arrive); `defineTool` is the typed sugar for first-party tools.

## A hook plugin (permission gate)

A hook wraps the `tools/execute` waterfall to veto or rewrite a call — the seam where sandbox, permission, and plan-mode plugins live.

```ts
import type { Context } from 'cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/execute', async (exec, next) => {
    if (!(await isAllowed(exec))) {
      return {
        callId: exec.callId,
        content: [{ type: 'text', text: 'Denied by policy.' }],
        isError: true,
      }
    }
    return next()
  })
}
```

## A UI plugin

A UI plugin consumes `agent/stream-chunk` and session events for rendering, and drives input back in via `agent.send()` / `agent.steer()`.

```ts
import type { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'

declare function render(text: string): void
declare function onUserInput(handler: (text: string) => void): void

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('agent/stream-chunk', (agent, turn, step, chunk) => {
    if (chunk.type === 'text-delta') render(chunk.text)
  })
  onUserInput(text => ctx.agents.get(AgentId('main'))?.send([{ type: 'text', text }]))
}
```

## A client-driver plugin (external protocol bridge)

A *client driver* is a UI plugin whose "user" is another program speaking a wire protocol rather than a human at a terminal. It owns the process's stdio (so it must run with **no stdout logger** — every non-protocol byte corrupts the stream), creates/resumes agents on demand through the `dsh-agent` factory seam, translates harness events (`session/event`, `agent/*`) into outbound protocol messages, and translates inbound requests back into `agent.send()` / `agent.cancel()`. Two harness-specific contracts make it correct: resolve each request exactly once off a settle signal (the turn can end without its `agent/turn-end` event firing — fall back through the logged `turn/end` record), and tear each agent down through its `AgentHandle.dispose()` (which stops the loop, `await`s its exit, and unregisters), not just `cancel()` — disposal must *reach* quiescence, not merely request it.

`packages/ui/acp` is the worked example: it bridges the agent to the Agent Client Protocol (JSON-RPC over stdio) so Zed and other ACP editors can drive it. See its README for the full method surface and the deferred-permission-gate note.

```ts
import type { Context } from 'cordis'

export const name = 'my-protocol-bridge'
export const inject = ['agents', 'sessions', 'sessionPersistence']

export function apply(ctx: Context) {
  // Stream every logged assistant text/reasoning delta out to the client.
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        // sendToClient({ kind: 'message_chunk', text: chunk.text })
      }
    }
  })
  // Inbound "prompt": create/resume an agent and feed it; settle on turn end.
  // Teardown reaches quiescence via AgentHandle.dispose() (stop + await exit).
}
```

## Runnable wirings

Three complete examples load their plugin trees from `cordis.yml`: [`examples/echo-agent`](../../examples/echo-agent) (mock model + echo tool — the all-mock skeleton check, `pnpm run demo:echo`), [`examples/coding-agent`](../../examples/coding-agent) (DeepSeek V4 + the bash tool suite — the real thing, `pnpm run demo:coding`), and [`examples/acp-agent`](../../examples/acp-agent) (the same coding agent exposed as an ACP server over JSON-RPC stdio — the client-driver shape, `pnpm run demo:acp`). Each leaf is now just its swappable backends plus an app-package entry: the stdio demos load [`@deepseek-ai/dsh-stdio-agent`](../../packages/ui/stdio-agent), the ACP demo loads [`@deepseek-ai/dsh-acp-agent`](../../packages/ui/acp-agent), and both app packages share the spine via the [`@deepseek-ai/dsh-agent-core`](../../packages/core/agent-core) bundle.
