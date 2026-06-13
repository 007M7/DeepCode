# Cookbook: adding a tool

How to give the model a new capability. Reference implementations: `examples/echo-agent/src/echo-tool.ts` (minimal) and `packages/tool-bash` (production-grade, three-package seam).

## The minimal shape

```ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    async execute(args, exec) {
      // args is TYPED from the schema: { path: string; limit?: number }
      // exec carries { callId, name, arguments, agent?, signal? }
      return [{ type: 'text', text: await readFile(args.path, 'utf8') }]
    },
  }))
}
```

Registration is effect-based: disposing the plugin fiber unregisters the tool (write the HMR test). Schemas flow into the system-prompt assembly automatically.

## Rules of the execute() contract

- **Validate args at runtime.** `defineTool`'s `InferArgs` typing is compile-time only; at runtime `arguments` is whatever JSON the model emitted. Check every field; throw a descriptive Error for bad input.
- **Throwing means isError.** The registry catches anything `execute()` throws and returns `{isError: true}` to the model. Use that for infrastructure failures (bad input, spawn errors, aborts) — but REPORT domain failures in the result text instead (e.g. tool-bash returns `[exit code: 9]` with `isError: false`: the model decides what a failing command means).
- **Honor `exec.signal`.** Cancel in-flight work when it fires.
- **Use `exec.agent` for async notifications.** `agent.inject(content, {source: {kind: 'plugin', plugin: '<name>'}})` appends durable context the NEXT model request sees — it is not a wake-up (an idle agent stays idle). Guard against disposed agents (try/catch).

## Long-running work

Follow tool-bash's background pattern: a `run_in_background` flag returns a task id immediately; companion tools poll incrementally and kill; completion notices arrive via `agent.inject()`. Bound buffers and spill full output to disk so nothing is silently lost.

> TODO: each tool reimplements this background pattern by hand today. At some
> point we need a generic long-running-tool layer that handles task ids,
> incremental polling, kill, and completion notices uniformly.

## Permissions / sandboxing

Prefer not to build policy into the tool. The seam is the `tools/execute` waterfall (veto or wrap — see the permission-gate example in [extension-cookbook.md](./extension-cookbook.md)), or a sandboxing implementation behind the tool's executor seam.

## Tests every tool needs

Arg-validation rejections, result shaping for every outcome, the HMR disposal test, and — for tools with side effects — an integration spec that drives the tool through the agent loop with a scripted `MockAdapter` (`packages/agent-loop/tests/mock-adapter.ts`), asserting the `tool/call` / `tool/result` session events.
