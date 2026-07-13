# Cookbook: extension plugin shapes

The three plugin shapes you write against the harness extension surface, as illustrative snippets (elided imports and helper stubs — not copy-paste-complete). For the full step-by-step guides see [adding a package](./adding-a-package.md), [adding a tool](./adding-a-tool.md), and [adding an LLM adapter](./adding-an-llm-adapter.md); for the seams these hook into see [docs/architecture.md](../architecture.md).

## A tool plugin

A tool registers on `ctx.tools`. The annotated `defineTool` example (typed `execute` args, result shaping, the `run_in_background` pattern) lives in [adding-a-tool.md](./adding-a-tool.md) — that guide is the source of truth for the tool shape. Raw JSON-Schema `ToolDefinition`s are also accepted by `ctx.tools.register()` directly (that is how MCP-sourced tools arrive); `defineTool` is the typed sugar for first-party tools.

## A hook plugin (permission gate)

A hook returns a typed decision from the `tools/pre-execute` gate to allow or deny a call — the seam where sandbox, permission, and plan-mode plugins live. (A "native hook" is just this: an ordinary cordis plugin on the interception seams, returning typed decisions — no external protocol needed.)

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

This waterfall is the reorderable policy layer. Use `ctx.tools.guard()` when an invariant needs a monotonic final denial, `tools/execute` when a plugin must wrap the actual dispatch lifetime (timeouts/retries/metrics; only `exec.signal` is replaceable), `tools/post-execute` for explicit result transformation, and `tools/result` for contained observation of the immutable final outcome. The [adding-a-tool guide](./adding-a-tool.md#execution-policy-and-observation) gives the selection rule.

## A UI plugin

A UI plugin renders from the `session/event` feed (the assistant token stream as `assistant/chunk`, plus turn/step boundaries and tool activity), and drives input back in via `agent.send()` / `agent.steer()`.

```ts
import type { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'

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
  onUserInput(text => ctx.agents.get(AgentId('main'))?.send([{ type: 'text', text }]))
}
```

## A client-driver plugin (external protocol bridge)

A *client driver* is a UI plugin whose "user" is another program speaking a wire protocol rather than a human at a terminal. It owns the process's stdio (so it must run with **no stdout logger** — every non-protocol byte corrupts the stream), creates/resumes agents on demand through the `dsh-agent` factory seam, translates harness events (`session/event`, `agent/*`) into outbound protocol messages, and translates inbound requests back into `agent.send()` / `agent.cancel()`. Two harness-specific contracts make it correct: correlate and settle each request exactly once from the durable `turn/end` session event even if rendering fails, and tear each agent down through its `AgentHandle.dispose()` (which stops the loop, `await`s its exit, and unregisters), not just `cancel()` — disposal must *reach* quiescence, not merely request it.

`packages/ui/acp` is the worked example: it bridges the agent to the Agent Client Protocol (JSON-RPC over stdio) so Zed and other ACP editors can drive it. See its README for the full method surface and the permission-prompt answerer it registers on the approval seam.

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

Three complete examples load their plugin trees from `cordis.yml`: [`examples/echo-agent`](../../examples/echo-agent) (mock model + echo tool — the all-mock skeleton check, `pnpm run demo:echo`), [`examples/coding-agent`](../../examples/coding-agent) (DeepSeek V4 + the bash tool suite behind a terminal REPL UI, `pnpm run demo:repl`), and [`examples/acp-agent`](../../examples/acp-agent) (an agent exposed as an ACP server over JSON-RPC stdio — the client-driver shape, `pnpm run demo:acp`). Each leaf is just its swappable backends plus an app-package entry: the stdio demos load [`@deepseek-ai/dsh-stdio-agent`](../../packages/ui/stdio-agent), the ACP demo loads [`@deepseek-ai/dsh-acp-agent`](../../packages/ui/acp-agent), and both app packages share the spine via the [`@deepseek-ai/dsh-agent-core`](../../packages/core/agent-core) bundle.

## The feature → mechanism map

Every product feature maps to a listener on a documented extension seam — the microkernel claim made checkable ([microkernel RFC](../rfc/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md)). No row modifies the loop.

`system-prompt/assemble` is an expert cooperative whole-assembly transform: its returned assembly is authoritative, so listener authors own preserving active Code Mode and structured-output protocol contributions. Prefer `ctx.tools.restrict()` for tool filtering that must stay aligned across presentation, lookup, and execution.

| Product feature | Plugin mechanism |
|---|---|
| Hook system (user + project level) | listeners on `agent/session-start`, `agent/prompt-submit`, `agent/request`, `agent/step-result`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-continuation` — each interception waterfall returns a typed Decision; the `dsh-hooks-claude` / `dsh-hooks-codex` bridges map hook config files onto these seams |
| `/goal` | force-continue via `agent/turn-continuation` + `steer()` reminders |
| `/loop` | on the `turn/end` session event, `send()` the next iteration; or force-continue |
| Dynamic workflow | `ctx.workflows` + the worker-thread engine + the `workflow` tool; structured in-process children enforce output with scoped prompt/tool registrations, a monotonic tool guard, final `tools/result` commit (including enclosing `run_code`), and terminal `agent/turn-stop` |
| Queued + steering messages | core `Agent.send()` / `Agent.steer()` |
| Context compaction (auto + manual) | the `ctx.compact` seam + a backend (`dsh-compact-basic`) on the serial `agent/pre-step` seam; auto = token-pressure check before each step; a manual trigger invokes the same `ctx.compact` routine ([compaction RFC](../rfc/implemented/feature/2026-06-18-compaction-capability-seam.md) — the model-facing `/compact` consumer tool is deferred) |
| System prompt configurability | `ctx.systemPrompt.section()` with ordering and scope-local shadowing |
| AGENTS.md (root) | a section provider reading the file |
| AGENTS.md (subdir, on-touch) + file-change notices | `agent.inject()` from a watcher / tool-result listener |
| Built-in tools | `ctx.tools.register()`; schemas flow into the assembly automatically — the `dsh-tool-*` families (bash, fs, web, subagent, todo) are the shipped examples |
| ToolSearch / progressive disclosure | replace a scoped `ctx.tools.restrict()` registration as the visible set changes; the registry keeps presentation, lookup, and execution aligned |
| Tool deadline / retry / metrics | wrap core dispatch with `tools/execute`; a wrapper may replace `exec.signal`, delegate, and inspect the normalized result in one lexical lifetime |
| Final tool-result metrics / audit / capture | observe immutable authoritative outcomes with `tools/result`; use `tools/post-execute` instead only when the plugin must transform the result or attach context |
| Monotonic terminal turn policy | return `{ action: 'stop' }` from serial `agent/turn-stop`, after continuation and steering have already been folded |
| Subprocess sandbox (landlock / sandbox-exec) | use a `ctx.sandbox` backend through `dsh-bash-sandbox`; use `tools/pre-execute` for capability-level denial |
| Permission system / AskUserQuestion | return `ask` from `tools/pre-execute` and answer through `ctx.approval`; register a separate model-facing ask tool for ordinary user questions |
| Plan mode | `tools/pre-execute` (deny writes) + a mode prompt section via `ctx.systemPrompt.section()` or `agent.inject()` (model-visible ⟺ logged: `agent/request` shapes call config only) |
| Sub-agent delegation | the `ctx.subagents` provider registry (`dsh-subagent-spawn`/`-fork`/`-acp`) + `dsh-tool-subagent` exposing one configured provider to the model |
| MCP | one plugin per server: discover tools → `ctx.tools.register()` |
| Skills | section + tool registration; `inject()` skill content on invocation |
| Memory | section provider + tool |
| Scheduled tasks (cron) | a plugin registers model-callable scheduling tools; timer fires → `send(…, {source: {kind: 'cron', …}})` when idle / `inject()` notification when busy |
| UI (GUI; CLI emits JSONL) | listen `session/event` (assistant chunks, boundaries, tool activity); input → `send()` |
| Telemetry / replayable trace | `session/event` → JSONL; replay = `sessions.create(id, { seed })` |
| Model adapters | `LlmAdapter` subclass via `registerAdapter` (`dsh-llm-deepseek`, `dsh-llm-pi-ai`) |
| Plugin hot-reload | every registration is a `ctx.effect` → vendored HMR just works |
