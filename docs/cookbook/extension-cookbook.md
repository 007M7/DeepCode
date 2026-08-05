# Cookbook: extension plugin shapes

English | [中文](extension-cookbook.zh.md)

Reference shapes for the harness extension surface. The snippets omit imports and helper implementations and are not copy-paste-complete. For concrete authoring paths, see the [package checklist](adding-a-package.md), [first-tool tutorial](../user/develop/basic/tool.md), [tool reference](adding-a-tool.md), and [LLM adapter guide](adding-an-llm-adapter.md); the [architecture](../architecture.md) owns the system and extension-seam map.

## A tool plugin

A tool registers on `ctx.tools`. The annotated `defineTool` example (typed `execute` args, result shaping, the `run_in_background` pattern) lives in [adding-a-tool.md](adding-a-tool.md) — that guide is the source of truth for the tool shape. Raw JSON-Schema `ToolDefinition`s are also accepted by `ctx.tools.register()` directly (that is how MCP-sourced tools arrive); `defineTool` is the typed sugar for first-party tools.

## A hook plugin (permission-gate example)

This permission gate is one example of a hook plugin. It returns a typed decision from the `tools/pre-execute` gate to allow or deny a call; sandbox, permission, and plan-mode plugins can use this seam. Hook plugins can intercept other seams and are not inherently permission gates. A "native hook" is an ordinary Cordis plugin on an interception seam; it needs no external protocol.

```ts
import type { Context } from 'cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

This waterfall is the reorderable policy layer. Use `ctx.tools.guard()` when an invariant needs a monotonic final denial, `tools/execute` when a plugin must wrap the actual dispatch lifetime (timeouts/retries/metrics; only `exec.signal` is replaceable), `tools/post-execute` for explicit result transformation, and `tools/result` for contained observation of the immutable final outcome. The [adding-a-tool guide](adding-a-tool.md#execution-policy-and-observation) gives the selection rule.

## A UI plugin

A UI plugin renders from the `session/event` feed (the assistant token stream as `assistant/chunk`, plus turn/step boundaries and tool activity), and drives input back in via `agent.followup()` / `agent.steer()`.

```ts
import type { Context } from 'cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

declare function render(text: string): void
declare function onUserInput(handler: (text: string) => void): void

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      render(event.data.chunk.text)
    }
  })
  onUserInput(text => ctx.agents.get(SessionId('client-session'))?.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })))
}
```

## An external protocol driver

A *protocol driver* adapts a wire peer to `ctx.agents`; it may serve a UI or an automation client. A stdio driver owns stdout, creates or resumes agents through the factory, maps the protocol's requests to `followup()` or `cancel()`, and settles each request exactly once from durable `turn/end`. Tear agents down with `AgentHandle.dispose()` so disposal reaches quiescence.

[`packages/acp/acp`](../../packages/acp/acp) is the automation-only worked example: it exposes fresh text sessions over Agent Client Protocol JSON-RPC stdio, emits committed assistant text, and registers a one-shot machine permission answerer for agents it owns. Its [README](../../packages/acp/acp/README.md) owns the exact method and lifecycle contract.

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

Runnable leaves load their plugin trees from `examples/*/cordis.yml`; the root `demo:*` scripts and those leaf directories are the authoritative inventory. Non-interactive leaves use [`@deepseek-ai/dsh-cli-demo`](../../packages/examples/cli-demo), ACP leaves use [`@deepseek-ai/dsh-acp-demo`](../../packages/examples/acp-demo), JSON-RPC leaves use [`@deepseek-ai/dsh-jsonrpc-demo`](../../packages/examples/jsonrpc-demo), and the app packages share [`@deepseek-ai/dsh-agent-spine-demo`](../../packages/examples/agent-spine-demo).
