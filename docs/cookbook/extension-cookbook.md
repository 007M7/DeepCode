# Cookbook: extension plugin shapes

The three plugin shapes you write against the harness extension surface, as illustrative snippets (elided imports and helper stubs — not copy-paste-complete). For the full step-by-step guides see [adding a package](./adding-a-package.md), [adding a tool](./adding-a-tool.md), and [adding an LLM adapter](./adding-an-llm-adapter.md); for the seams these hook into see [docs/architecture.md](../architecture.md).

## A tool plugin

A tool registers on `ctx.tools`. The annotated `defineTool` example (typed `execute` args, result shaping, the `run_in_background` pattern) lives in [adding-a-tool.md](./adding-a-tool.md) — that guide is the source of truth for the tool shape. Raw JSON-Schema `ToolDefinition`s are also accepted by `ctx.tools.register()` directly (that is how MCP-sourced tools arrive); `defineTool` is the typed sugar for first-party tools.

## A hook plugin (permission gate)

A hook wraps the `tools/execute` waterfall to veto or rewrite a call — the seam where sandbox, permission, and plan-mode plugins live.

```ts
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
export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('agent/stream-chunk', (agent, turn, step, chunk) => {
    if (chunk.type === 'text-delta') render(chunk.text)
  })
  onUserInput(text => ctx.agents.get('main')?.send([{ type: 'text', text }]))
}
```

## Runnable wirings

Two complete examples load their plugin trees from `cordis.yml` with HMR: [`examples/echo-agent`](../../examples/echo-agent) (mock model + echo tool — the all-mock skeleton check, `yarn demo:echo`) and [`examples/coding-agent`](../../examples/coding-agent) (DeepSeek V4 + the bash tool suite — the real thing, `yarn demo:coding`).
