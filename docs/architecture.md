# DeepSeek Harness Architecture

This document describes the phase-1 architecture of the DeepSeek Harness — the
foundation of **DeepSeek Code**. The governing principle, from the
[microkernel design discussion][microkernel-doc], is:

> **Microkernel approach. Everything is a plugin.**

The harness core is deliberately tiny: a handful of abstract services plus one
concrete plugin (the agent loop). Every product feature — tools, hooks,
compaction, sandboxing, UI, persistence, sub-agents, MCP, skills — is meant to
be written as a plugin against the extension surface described here, without
modifying the loop.

Requirement context: [Coding Harness MVP 需求分析][mvp-doc].

[microkernel-doc]: https://trtgsjkv6r.feishu.cn/wiki/VS9Lw1kQki6mDJk2UHocyuphnsc
[mvp-doc]: https://trtgsjkv6r.feishu.cn/wiki/ZwK6wfBE9i91V6kzMGYcgRGanxg

## Layering

```
┌─────────────────────────────────────────────────────────────┐
│  future plugins: tools, hooks, compaction, sandbox, UI, MCP… │
├─────────────────────────────────────────────────────────────┤
│  @deepseek-ai/dsh-agent-loop      (the ONE concrete plugin)  │
├─────────────────────────────────────────────────────────────┤
│  @deepseek-ai/dsh-agent           (vocabulary + registry)    │
│  @deepseek-ai/dsh-tools           (registry + exec waterfall)│
│  @deepseek-ai/dsh-system-prompt   (assembly registry)        │
│  @deepseek-ai/dsh-session         (event-sourced log)        │
│  @deepseek-ai/dsh-llm             (abstract model service)   │
├─────────────────────────────────────────────────────────────┤
│  vendor/: cordis, loader, include, group, timer, hmr,        │
│           logger-console, cosmokit, schemastery              │
└─────────────────────────────────────────────────────────────┘
```

Dependency rule: plugins depend on interface packages, never on
`dsh-agent-loop`. The loop itself is swappable — UI/hook/tool plugins keep
working against the `dsh-agent` vocabulary if the loop is replaced.

## Service map

| ctx key | Class | Package | Role |
|---|---|---|---|
| `ctx.llm` | `LlmService` | dsh-llm | adapter registry; `stream()` / `streamBlocks()` / `generate()` |
| `ctx.sessions` | `SessionStore` | dsh-session | creates/holds event-sourced `Session`s |
| `ctx.systemPrompt` | `SystemPrompt` | dsh-system-prompt | ordered sections + tool schemas → `assemble()` |
| `ctx.tools` | `ToolRegistry` | dsh-tools | tool definitions; `execute()` through waterfall |
| `ctx.agents` | `AgentRegistry` | dsh-agent | live `Agent` handles |
| `ctx.agentLoop` | `AgentLoop` | dsh-agent-loop | creates `LoopAgent`s and drives their loops |

All registrations (`registerAdapter`, `section`, `tools`, `register`, …) go
through `ctx.effect()` and return disposers, so plugin hot-reload (vendored
HMR) and fiber disposal clean up automatically.

## The vocabulary (dsh-llm)

Messages are arrays of typed **content blocks** (`text`, `reasoning`,
`tool-call`, `tool-result`, `image`); the union is derived from the
merge-extensible `ContentBlockMap`, so plugins can add block types via
declaration merging. The same merge-extensible-map pattern is used for
`MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason` — typed
sum types instead of strings.

Streaming is a raw chunk protocol (`block-start`, `text-delta`,
`reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`).
`BlockAssembler` is the single shared implementation that assembles chunks
into blocks/messages; the loop logs raw chunks (replay fidelity) while feeding
the same chunks through an assembler.

`LlmAdapter` is the provider seam: subclass, implement `stream()`, call
`ctx.llm.registerAdapter(models, adapter)`.
**TODO**: the DeepSeek V4 adapter is the first real adapter (next phase); the
streaming protocol gets a careful review then.

## Event-sourced sessions (dsh-session)

A `Session` is an append-only log of typed `SessionEvent`s — the single source
of truth. The LLM message history is *derived* from the log
(`deriveMessages()`):

- `user/message` → user message
- `assistant/message` → assistant message (raw `assistant/chunk` events are
  replay/UI data and are skipped in derivation)
- `tool/result` → user message carrying a `tool-result` block
- `context/message`, `steering/message` → user-role messages wrapped in a
  tagged envelope (`<context source="…">…</context>`) at their chronological
  position — the "system-reminder" pattern; models distinguish them from real
  user prompts by the envelope. **TODO(review)**: revisit the envelope once a
  real adapter exists.

Replay/fork = `ctx.sessions.create(id, seedEvents)`. Trace/telemetry = listen
to `session/event`.

**Durability seam**: `session/event` is a synchronous notification;
persistence plugins buffer (write-behind) and drain at the awaited
`session/flush` checkpoint the loop fires at every turn end (see
`examples/echo-agent/src/session-jsonl.ts` for the pattern).
**TODO**: real persistence backends (JSONL per session dir, sqlite) are a
future phase.

## Prompt assembly (dsh-system-prompt)

Plugins contribute `PromptSection`s (named, ordered, static or computed) and
tool-schema providers. `assemble()` returns a `PromptAssembly { sections,
tools }` through the `system-prompt/assemble` waterfall.

Tool schemas are deliberately **part of the assembly**: "what the model is
told it can do" is one coherent thing managed here, even though adapters
transmit schemas as the wire-level `tools` field rather than prompt text.

## Tool pipeline (dsh-tools)

`ToolRegistry.register()` takes schema + `execute()`. The registry feeds its
schemas into the system-prompt assembly automatically.

`execute()` runs through the **`tools/execute` waterfall** — the single seam
where sandbox, permission, hooks, and plan-mode plugins wrap or veto a call.
This collapses Claude Code's validate → PreToolUse → permission → execute →
PostToolUse pipeline into ordered waterfall listeners.

**TODO**: tool shapes get revisited when real tools land (e.g. a
concurrency-safety hint for parallel execution; phase 1 executes tool calls
sequentially).

## Agents (dsh-agent) and the loop (dsh-agent-loop)

`Agent` is the handle every plugin programs against:

- `send(content)` — queued message; starts a turn when idle, else next turn
- `steer(content)` — mid-turn injection, drained **between steps**; behaves
  like `send` when idle
- `inject(content)` — in-session context (`context/message` event) without
  triggering a turn; the next request sees it (Claude Code attachment /
  system-reminder analog)
- `abort(reason)` — aborts the in-flight step via `AbortSignal`
- `session`, `status`, `options`

**TODO(sub-agents)**: `spawn`/`fork` land on `AgentLoop.create()` — fork seeds
the child Session with the parent's event log, spawn starts fresh; children
are ordinary `Agent` handles so `steer()` and event subscription work
uniformly. Inter-agent channels beyond these primitives are deliberately
deferred.

### Loop lifecycle (session / turn / step)

- **Session**: the whole event log of one agent.
- **Turn**: triggered by ≥1 queued message; runs steps until the model stops
  requesting tools and no plugin requests continuation.
- **Step**: one model request + its tool executions.

```
forever:
  wait for queued messages (idle)
  emit agent/status(running)
  TURN (error-contained — a throwing plugin ends the turn, never the loop):
    drain queued → session('user/message'…) → 'turn/start' → emit agent/turn-start
    STEP loop:
      drain steering (late steering from previous step's listeners)
      emit agent/step-start
      assembly = ctx.systemPrompt.assemble()          ⟵ waterfall system-prompt/assemble
      req = {model, system, tools, messages: session.deriveMessages(), signal}
      req = waterfall agent/request                   ⟵ hooks, compaction, model switch
      stream ctx.llm.stream(req)                      ⟵ waterfall llm/stream (raw chunks)
        session('assistant/chunk'); emit agent/stream-chunk
      msg = waterfall agent/step-result               ⟵ runs BEFORE the log append, so the
      session('assistant/message', 'usage')              log records what tool dispatch uses
      each tool-call (sequential, abort-checked between calls):
        session('tool/call'); ctx.tools.execute()     ⟵ waterfall tools/execute
        session('tool/result')
      drain steering → session('steering/message'); emit agent/steering
      emit agent/step-end
      cont = waterfall agent/turn-continuation(default = hadToolCalls || steered)
      steering pending from step-end/continuation listeners forces cont = true
      if !cont: break
  session('turn/end'); emit agent/turn-end
  await ctx.parallel('session/flush', session)        ⟵ durability checkpoint (failure
                                                         reported via agent/error, not fatal)
  leftover steering re-enqueued as queued messages    ⟵ steering is never stranded
  emit agent/status(idle) unless more queued
```

Error containment: a throwing `agent/turn-continuation` listener or a
rejecting `session/flush` ends the **turn** with an `error` event — never the
driver loop. `abort()` is honored mid-stream **and** between tool calls;
disposal mid-turn ends the turn with reason `disposed` and emits
`agent/status('disposed')`.

### Event taxonomy

Declared in `@deepseek-ai/dsh-agent` (so nothing depends on the loop package).

| Event | Mode | Purpose |
|---|---|---|
| `agent/created` / `agent/disposed` / `agent/status` / `agent/queued` | emit | lifecycle + inbox notifications |
| `agent/turn-start` / `agent/turn-end` / `agent/step-start` / `agent/step-end` | emit | boundaries |
| `agent/request` | **waterfall** | mutate the final `GenerateOptions` before the model call |
| `agent/stream-chunk` | emit | token-level UI/log feed |
| `agent/step-result` | **waterfall** | post-process the assistant message before tool dispatch |
| `agent/steering` | emit | steering content injected |
| `agent/turn-continuation` | **waterfall** | override the continue/stop decision |
| `agent/error` | emit | step/turn errors |
| `tools/execute` (dsh-tools) | **waterfall** | wrap/veto/sandbox tool execution |
| `llm/stream` / `llm/generate` (dsh-llm) | **waterfall** | model-call interception |
| `system-prompt/assemble` (dsh-system-prompt) | **waterfall** | mutate the assembly |
| `session/created` / `session/event` (dsh-session) | emit | session lifecycle + log feed |
| `session/flush` (dsh-session) | parallel (awaited) | durability checkpoint |

### Cordis waterfall semantics (important)

`ctx.waterfall` is **around-middleware**, not a value reducer. Each listener
receives `(...args, next)`:

- call `next()` to delegate to later listeners (and ultimately the core
  behavior), possibly wrapping it;
- return a value **without** calling `next()` to short-circuit (veto);
- listeners run in registration order; `prepend: true` jumps the queue.

Composition caveat: values propagate through `next()`'s **return value**.
Mutating the passed-in object works when later listeners receive the same
reference, but a listener that returns a *new* object makes earlier mutations
invisible downstream. Prefer mutate-then-`next()` for cooperative middleware;
return a replacement only when you mean to take over the result.

## Plugin sanity checklist

Every MVP feature (including the TODO-marked ones), with the mechanism that
implements it **without modifying the loop**:

| MVP feature | Plugin mechanism |
|---|---|
| Hook system (user + project level) | listeners on `agent/request`, `agent/step-result`, `tools/execute`, `agent/turn-continuation`; a hooks plugin bridges config files to shell commands |
| `/goal` | force-continue via `agent/turn-continuation` + `steer()` reminders |
| `/loop` | on `agent/turn-end`, `send()` the next iteration; or force-continue |
| Dynamic workflow | orchestrator plugin on `agent/turn-end` / `agent/step-end` driving `send`/`steer` (+ sub-agents later) |
| Queued + steering messages | core `Agent.send()` / `Agent.steer()` |
| Context compaction (auto + manual) | wrap `agent/request`: measure tokens, rewrite `req.messages`, append merged `compaction/*` session events; manual = a command plugin invoking the same routine |
| System prompt configurability | `ctx.systemPrompt.section()` with ordering |
| AGENTS.md (root) | a section provider reading the file |
| AGENTS.md (subdir, on-touch) + file-change notices | `agent.inject()` from a watcher / tool-result listener |
| Built-in tools (Read/Write/Edit/Bash/…) | `ctx.tools.register()`; schemas flow into the assembly automatically |
| ToolSearch / progressive disclosure | wrap `agent/request`, filter `req.tools` |
| Tool sandbox (landlock / sandbox-exec) | wrap `tools/execute` |
| Permission system / AskUserQuestion | wrap `tools/execute` (veto or ask); register an ask tool |
| Plan mode | wrap `tools/execute` (deny writes) + `agent/request` (inject mode prompt) |
| Sub-agents (spawn / fork / steer) | TODO seam on `AgentLoop.create()`; fork = seed Session with parent events; `steer()` on the child handle |
| MCP | one plugin per server: discover tools → `ctx.tools.register()` |
| Skills | section + tool registration; `inject()` skill content on invocation |
| Memory | section provider + tool |
| Scheduled tasks (cron) | plugin registers model-callable scheduling tools; timer fires → `send(…, {source: {kind: 'cron', …}})` when idle / `inject()` notification when busy |
| UI (GUI; CLI emits JSONL) | listen `agent/stream-chunk` + `session/event`; input → `send()` |
| Telemetry / replayable trace | `session/event` → JSONL; replay = `sessions.create(id, seed)` |
| DeepSeek V4 (and other) models | `LlmAdapter` subclass via `registerAdapter` |
| Plugin hot-reload | every registration is a `ctx.effect` → vendored HMR just works |

## Extension cookbook

### A tool plugin

```ts
import type { Context } from 'cordis'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'read_file',
    description: 'Read a file from disk.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute(args: any) {
      const text = await readFile(args.path, 'utf8')
      return [{ type: 'text', text }]
    },
  })
}
```

### A hook plugin (permission gate)

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

### A UI plugin

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

A complete runnable wiring lives in [`examples/echo-agent`](../examples/echo-agent)
(mock model + echo tool + stdio UI + JSONL persistence, loaded from
`cordis.yml` with HMR).

## Deferred work (TODO)

Tracked here deliberately — each is designed-for but not implemented:

- **Sub-agent spawn/fork semantics** (seam: `AgentLoop.create()`); inter-agent
  channels beyond `send`/`steer`/events.
- **Persistence backends** (JSONL session dirs, sqlite) on the
  `session/event` + `session/flush` seam.
- **Compaction implementation** (auto thresholds, summarization prompts) on
  the `agent/request` seam, with its session-event types added by declaration
  merging.
- **DeepSeek V4 adapter** — first real `LlmAdapter`; triggers the
  streaming-protocol review (`TODO(review)` markers in dsh-llm).
- **Parallel tool execution** (concurrency-safety hints on ToolDefinition).
- **Session branching/tree** (pi-style entry tree) if needed beyond seed-based
  forking.
- **Session event vocabulary review** once the loop and a persistence plugin
  coexist (`TODO(review)` in dsh-session).
