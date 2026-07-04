# DeepSeek Harness Architecture

This document describes the phase-1 architecture of the DeepSeek Harness — the foundation of **DeepSeek Code**. The governing principle, from the [microkernel design discussion][microkernel-doc], is:

> **Microkernel approach. Everything is a plugin.**

The harness core is deliberately tiny: a handful of abstract services plus one concrete loop plugin (`dsh-agent-loop`). Every product feature — tools, hooks, compaction, sandboxing, UI, persistence, sub-agents, MCP, skills — is meant to be written as a plugin against the extension surface described here, without modifying the loop.

Requirement context: [Coding Harness MVP 需求分析][mvp-doc].

For a catalog of the **data structures** this architecture moves around — the core vocabulary types, their literal shapes, and the seam types grouped by capability — see [core-data-structures/](core-data-structures/core.md). This document covers behavior; that one covers the types.

**Contents:** [Layering](#layering) · [Service map](#service-map) · [Capability seams](#capability-seams-interface--implementation--consumer) · [The vocabulary (dsh-llm)](#the-vocabulary-dsh-llm) · [Event-sourced sessions](#event-sourced-sessions-dsh-session) · [Prompt assembly](#prompt-assembly-dsh-system-prompt) · [Tool pipeline](#tool-pipeline-dsh-tools) · [Agents and the loop](#agents-dsh-agent-and-the-loop-dsh-agent-loop) ([lifecycle](#loop-lifecycle-session--turn--step), [event taxonomy](#event-taxonomy), [waterfall semantics](#cordis-waterfall-semantics-important)) · [Plugin sanity checklist](#plugin-sanity-checklist) · [Extension cookbook](#extension-cookbook) · [Deferred work](#deferred-work-todo)

[microkernel-doc]: https://trtgsjkv6r.feishu.cn/wiki/VS9Lw1kQki6mDJk2UHocyuphnsc
[mvp-doc]: https://trtgsjkv6r.feishu.cn/wiki/ZwK6wfBE9i91V6kzMGYcgRGanxg

## Layering

```
┌─────────────────────────────────────────────────────────────┐
│  future plugins: hooks, compaction, sandbox, UI, MCP…        │
├─────────────────────────────────────────────────────────────┤
│  @deepseek-ai/dsh-agent-loop      (the ONE concrete plugin)  │
│  @deepseek-ai/dsh-bash-local      (bash impl)                │
│  @deepseek-ai/dsh-tool-bash       (bash tool schemas)        │
│  @deepseek-ai/dsh-fs-local        (filesystem impl)          │
│  @deepseek-ai/dsh-fs-policy       (filesystem policy gate)   │
│  @deepseek-ai/dsh-tool-fs         (filesystem tools+executor)│
│  @deepseek-ai/dsh-web-search-exa  (web search impl)          │
│  @deepseek-ai/dsh-web-search-perplexity (web search impl)    │
│  @deepseek-ai/dsh-web-search-deepseek (web search impl)      │
│  @deepseek-ai/dsh-web-fetch-local (web fetch impl)           │
│  @deepseek-ai/dsh-tool-web        (web tool schemas)         │
│  @deepseek-ai/dsh-subagent-*      (subagent providers)       │
│  @deepseek-ai/dsh-session-persistence-jsonl (persistence impl)│
├─────────────────────────────────────────────────────────────┤
│  @deepseek-ai/dsh-agent           (vocabulary + registry)    │
│  @deepseek-ai/dsh-tools           (registry + exec waterfall)│
│  @deepseek-ai/dsh-system-prompt   (assembly registry)        │
│  @deepseek-ai/dsh-session         (event-sourced log)        │
│  @deepseek-ai/dsh-session-persistence (persistence seam)     │
│  @deepseek-ai/dsh-llm             (abstract model service)   │
│  @deepseek-ai/dsh-bash            (abstract bash executor)   │
│  @deepseek-ai/dsh-fs              (filesystem provider seam)  │
│  @deepseek-ai/dsh-web             (abstract web access)      │
│  @deepseek-ai/dsh-compact         (abstract compaction seam) │
│  @deepseek-ai/dsh-subagent        (provider registry seam)   │
├─────────────────────────────────────────────────────────────┤
│  vendor/: cordis, loader, include, group, timer, hmr,        │
│           logger-console, cosmokit, schemastery              │
└─────────────────────────────────────────────────────────────┘
```

Dependency rule: **extension** plugins depend on interface packages, never on `dsh-agent-loop`. The loop itself is swappable — UI/hook/tool plugins keep working against the `dsh-agent` vocabulary if the loop is replaced. The one sanctioned exception is a **composition/bundle** package whose job IS to assemble the concrete spine: `dsh-agent-core` bundles `dsh-agent-loop` (and the other concrete spine plugins) by design, so it depends on the concrete loop on purpose. The rule constrains plugins that EXTEND the system, not the bundle that COMPOSES it — swapping the loop means publishing a different bundle, not rewiring every extension.

## Service map

| ctx key | Class | Package | Role |
|---|---|---|---|
| `ctx.llm` | `LlmService` | dsh-llm | adapter registry; `stream()` |
| `ctx.sessions` | `SessionStore` | dsh-session | creates/holds event-sourced `Session`s |
| `ctx.sessionPersistence` | `SessionPersistence` (abstract) | dsh-session-persistence | durable persistence seam: create/append/load/list sessions |
| `ctx.systemPrompt` | `SystemPrompt` | dsh-system-prompt | ordered sections + tool schemas → `assemble()` |
| `ctx.tools` | `ToolRegistry` | dsh-tools | tool definitions; `execute()` through waterfall |
| `ctx.agents` | `AgentRegistry` | dsh-agent | live `Agent` handles + the create/resume factory seam (returns an `AgentHandle` = `{ agent, dispose() }` for owned per-agent teardown) |
| `ctx.agentLoop` | `AgentLoop` | dsh-agent-loop | creates `ReactLoopAgent`s and drives their loops |
| `ctx.bash` | `BashExecutor` (abstract) | dsh-bash | bash execution seam: foreground runs + background tasks |
| `ctx.fs` | `FileSystem` (abstract) | dsh-fs | filesystem provider seam: path resolution, stat, text read/stream, atomic writes/edits (optional version guard); owns the `fs/*` policy events |
| `ctx.compact` | `CompactService` (abstract) | dsh-compact | compaction seam: decide when history is too large, summarize an older range into a single surface node |
| `ctx.web` | `WebService` | dsh-web | web access seam: search/fetch provider registries, registration-order-independent selection, the `WebError` taxonomy |
| `ctx.subagents` | `SubagentService` | dsh-subagent | named provider registry for delegating a task to child agents |

All registrations (`registerAdapter`, `section`, `tools`, `register`, …) go through `ctx.effect()` and return disposers, so plugin hot-reload (vendored HMR) and fiber disposal clean up automatically.

For each service's full public interface (every method signature, generated from source), plus the inherited cordis-core/loader/hmr/timer surface a plugin also sees, see the `## Services` section of [cordis-catalog/events-and-services.md](cordis-catalog/events-and-services.md). This table is the at-a-glance role summary; that catalog is the exhaustive reference.

## Capability seams: interface / implementation / consumer

Swappable capabilities are split into **three packages** so each part evolves independently. The bash capability is the template:

1. **Interface** (`dsh-bash`) — an abstract service plus the vocabulary types (`BashExecutor`, `BashRunResult`, `BashTask`, …). Defines the contract, owns the `ctx.bash` key, depends only on cordis.
2. **Implementation** (`dsh-bash-local`) — a concrete subclass loaded as a plugin (local subprocesses, process-group kills, spill-file truncation). Sandboxed, containerized, or remote backends are sibling packages implementing the same interface.
3. **Consumer** (`dsh-tool-bash`) — what the model and other plugins program against (the `bash`/`bash_output`/`bash_kill` tool schemas). Consumers `inject` the interface's ctx key and never import implementation types.

The LLM seam has the same topology folded differently: `dsh-llm` carries the interface (`LlmAdapter`) AND the consumer surface (`ctx.llm.stream()`), with adapters as implementation packages — there the consumer is the loop itself, not a swappable schema surface. Use the full three-package split when the consumer is independently replaceable; keep interface + consumer together when they are one concern. Don't split preemptively: a capability with one conceivable implementation and one consumer stays one package until proven otherwise.

The filesystem capability follows the bash topology with a fourth layer, but the policy is contributed through an **event gate**, not a method service: `dsh-fs` owns the abstract `ctx.fs` provider seam (text IO + atomic mutation primitives whose version guard is optional) and the `fs/*` policy event vocabulary, `dsh-fs-local` provides the local backend, `dsh-tool-fs` is the model-facing `read`/`write`/`edit` tools AND the executor (it reads/writes/edits through `ctx.fs` directly, owns read windowing, dispatches the `fs/*` events), and `dsh-fs-policy` is a policy PLUGIN (no service) that decides the `fs/write-intent`/`fs/edit-intent` waterfalls and records on `fs/observed` to add observed-state + read-before-edit + version-guarded write/edit. Because the tool is not method-coupled to the policy, dropping `dsh-fs-policy` gracefully loses the policy and leaves the unconstrained bare provider rather than breaking the tool at a service-injection boundary. The demo agents (`coding-agent`, `acp-agent`) wire the full stack — `dsh-fs-local` + `dsh-fs-policy` + `dsh-tool-fs` — so `read`/`write`/`edit` are the default file surface (bash stays for shell/tests/search); the tools resolve a relative path against the caller's session cwd, matching bash ([the per-session cwd RFC](rfc/implemented/architecture/2026-07-02-fs-per-session-cwd.md)). See [the fs-policy event-gate RFC](rfc/implemented/architecture/2026-06-26-file-context-as-event-gate.md).

The web capability uses the same three-package split but folds two capabilities onto one seam: `dsh-web` owns the abstract `ctx.web` service, which is a provider REGISTRY (`registerSearchProvider`/`registerFetchProvider`, registration-order-independent selection, the `WebError` taxonomy) rather than a single backend. Providers register capabilities, not tools — `dsh-web-search-exa`, `dsh-web-search-perplexity`, `dsh-web-search-deepseek`, and `dsh-web-fetch-local` each register into `ctx.web` the way an `LlmAdapter` registers into `ctx.llm`, so they are namespace plugins (`inject: ['web']`), not key-owning services. `dsh-tool-web` is the single consumer that owns the model-facing `web_search`/`web_fetch` schemas, prompt sections, and presentation; it reads only the aggregated `ctx.web.searchStatus()`/`fetchStatus()` and executes through `ctx.web.search()`/`fetch()`, so provider selection has one owner. Search and fetch are deliberately one seam (one thing to inject and configure, one selection policy, one abort/error vocabulary) despite sharing no request schema — see the [web capability seam RFC](rfc/implemented/architecture/2026-06-24-web-capability-seam.md).

> **"Capability" — two unrelated meanings.** (1) The *seam pattern* above ("one plugin provides a capability, another needs it") is realized by plain Cordis **services + `inject`**: a provider registers a service (`ctx.bash`, declared in `interface Context`); a consumer declares `inject: ['bash']` and its fiber stays pending until the service exists, tearing down via HMR if it later vanishes. No extra library is needed. (2) `@cordisjs/plugin-capability` is a different axis entirely — a **permission/capability-security** service (named permissions with inheritance/dependency, tested against a session via `ctx.capability.test`). It is a candidate for the deferred permissions/sandbox work (the `tools/pre-execute` deny/ask gate), NOT a mechanism for swapping implementations.

## The vocabulary (dsh-llm)

Messages are arrays of typed **content blocks** (`text`, `reasoning`, `tool-call`, `tool-result`, `image`); the union is derived from the merge-extensible `ContentBlockMap`, so plugins can add block types via declaration merging. The same merge-extensible-map pattern is used for `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason` — typed sum types instead of strings.

Streaming is a raw chunk protocol (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`). `BlockAssembler` is the single shared implementation that assembles chunks into blocks/messages; the loop logs raw chunks (replay fidelity) while feeding the same chunks through an assembler.

`LlmAdapter` is the provider seam: subclass, implement `stream()`, call `ctx.llm.registerAdapter(models, adapter)`. Two real adapters implement it — `dsh-llm-deepseek` (hand-rolled fetch/SSE against the DeepSeek API) and `dsh-llm-pi-ai` (the same endpoint through the `@earendil-works/pi-ai` library). They exist as a pair deliberately: two independent internals over one contract verified the StreamChunk protocol, which is now documented (in `dsh-llm/src/types.ts`) with the conventions that review pinned down — usage before finish, nothing after finish, raw-string tool arguments, and the two sanctioned error paths (thrown vs `finish {kind:'error'}`).

## Event-sourced sessions (dsh-session)

A `Session` is an append-only log of typed `SessionEvent`s — the single source of truth. The LLM message history is *derived* from the log (`deriveMessages()`):

- `user/message` → user message
- `assistant/message` → assistant message (raw `assistant/chunk` events are replay/UI data and are skipped in derivation; an empty-content `assistant/message`, which exists only to host a max-tokens step's `usage`, is skipped too)
- `tool/result` → user message carrying a `tool-result` block
- `context/message`, `steering/message` → user-role messages wrapped in a tagged envelope (`<context source="…">…</context>`) at their chronological position — the "system-reminder" pattern; models distinguish them from real user prompts by the envelope. Live-adapter review has validated the tagged-envelope rendering against current DeepSeek behavior; provider-specific mismatches belong in that adapter.

Replay/fork = `ctx.sessions.create(id, { seed: seedEvents })`. Trace/telemetry = listen to `session/event`.

**Durability seam**: `session/event` is a synchronous notification; persistence plugins buffer (write-behind) and drain at the awaited `session/flush` checkpoint the loop fires at every turn end. The durable backend is a real **capability seam**: the abstract `SessionPersistence` service (`dsh-session-persistence`, `ctx.sessionPersistence`) defines create/append/load/list over the existing `SessionEvent` (no parallel persisted type), and `dsh-session-persistence-jsonl` is the first implementation — an append-only JSONL log per session with crash-safe atomic writes, crash recovery that PRESERVES an interrupted turn (closing it with a synthetic `turn/end {interrupted}` rather than truncating — a turn can be huge), and a read/replay path. Session metadata (format version, cwd, lineage, seed boundary) travels separately as `SessionHeader`, attached to a `Session` via `session.header`. Resuming a persisted session into a live agent is `ctx.agents.resume({ resumeSessionId })`. A second backend, `dsh-session-persistence-sqlite` (`node:sqlite`, one row per `SessionEvent` — the row shape `(session_id, seq, type, time, data, source_event_seqs, surface_op)` maps 1:1 onto it), passes the same `runPersistenceContract` suite, proving the seam is genuinely backend-agnostic.

## Prompt assembly (dsh-system-prompt)

Plugins contribute `PromptSection`s (named, ordered, static or computed) and tool-schema providers. `assemble()` returns a `PromptAssembly { sections, tools }` through the `system-prompt/assemble` waterfall.

Tool schemas are deliberately **part of the assembly**: "what the model is told it can do" is one coherent thing managed here, even though adapters transmit schemas as the wire-level `tools` field rather than prompt text.

## Tool pipeline (dsh-tools)

`ToolRegistry.register()` takes schema + `execute()`. The registry feeds its schemas into the system-prompt assembly automatically.

`execute()` runs through a **two-waterfall pipeline** — `tools/pre-execute` (the allow/deny/ask gate) → core dispatch → `tools/post-execute` (inspect/replace the result, attach context) — the seams where sandbox, permission, hooks, and plan-mode plugins gate or transform a call. This maps Claude Code's validate → PreToolUse → permission → execute → PostToolUse pipeline onto two ordered waterfalls: `pre-execute` returns a `PreToolDecision` (allow/deny/ask), `post-execute` a `PostToolDecision` (accept/block, optionally replacing content or attaching `additionalContext`). Core dispatch sits between them as plain code, inside `execute`'s outer try/catch, with the tool body's own try/catch preserved so a thrown tool still reaches `post-execute` as an `isError`.

**TODO**: tool shapes get revisited now that real tools exist (the bash suite landed; the `TODO(review)` in dsh-tools is still open) — e.g. a concurrency-safety hint for parallel execution; phase 1 executes tool calls sequentially.

## Agents (dsh-agent) and the loop (dsh-agent-loop)

`Agent` is the handle every plugin programs against:

- `send(content)` — queued message; starts a turn when idle, else next turn
- `steer(content)` — mid-turn injection, drained **between steps**; behaves like `send` when idle
- `inject(content)` — in-session context (`context/message` event); the next request sees it (Claude Code attachment / system-reminder analog). An inject made while the agent is *running* joins the open turn; an inject while *idle* is wrapped in a one-shot turn (`turn/start{trigger:injection}` → `context/message` → `turn/end`) so every event stays turn-enclosed (see [the turn-enclosure invariant](rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md)).
- `cancel(reason)` — the single public stop primitive: clears queued + steering work, aborts the in-flight step, and drops a turn about to start (the pre-step window) so a queued-but-not-started prompt never runs and cannot be batched into the cancelled turn. A UI/ACP `session/cancel` maps to it.
- `whenIdle()` — resolves once the agent reaches quiescence after settling out of `running` (resolves immediately when already idle; awaits the loop exit when disposed). A non-owner's quiescence-observation hook: it lets a consumer await the current work settling **without** disposing the agent. It is NOT teardown — it does not stop queued work, unregister the agent, or detach the session; a lifecycle owner tears an agent down with `await AgentHandle.dispose()` (which stops the loop, awaits its exit, and unregisters).
- `session`, `status`, `options`

**Subagents**: `spawn`/`fork` are realized by the [`@deepseek-ai/dsh-subagent`](../packages/subagent/subagent) seam (a named-provider registry on `ctx.subagents`), not a method on `Agent`. The in-process backends create the child via `ctx.agents.create` — fork seeds the child Session with a balanced completed-turn prefix of the parent's log (`CreateAgentOptions.seed`), spawn starts fresh; children are ordinary `Agent` handles so `steer()` and event subscription work uniformly. Out-of-process transports (ACP, and later A2A / Codex app-server / Claude Code SDK) register as sibling providers. See [docs/core-data-structures/subagent.md](core-data-structures/subagent.md) and [the subagent RFC](rfc/implemented/feature/2026-06-21-subagent-capability-seam.md). Inter-agent channels beyond delegation remain deferred.

### Loop lifecycle (session / turn / step)

- **Session**: the whole event log of one agent.
- **Turn**: triggered by ≥1 queued message; runs steps until the model stops requesting tools and no plugin requests continuation.
- **Step**: one model request + its tool executions.

```
create agent → emit agent/session-start(source)       ⟵ once, before turn 1 (startup|resume)
forever:
  wait for queued messages (idle)
  emit agent/status(running)
  TURN (error-contained — a throwing plugin ends the turn, never the loop):
    'turn/start'                                        ⟵ durable turn boundary (no agent/* mirror)
    each queued msg: waterfall agent/prompt-submit      ⟵ allow (rewrite/+context) | block
      allow → session('user/message'…); inject additionalContext
    every prompt blocked → 'turn/end'(rejected), 0 steps ⟵ zero-step turn, model never called
    STEP loop:
      drain steering (late steering from previous step's listeners)
      assembly = ctx.systemPrompt.assemble()          ⟵ waterfall system-prompt/assemble
      await ctx.serial('agent/pre-step')              ⟵ surface mutation (compaction) OUTSIDE the step
      session('step/start')                           ⟵ durable step boundary (no agent/* mirror)
      req = {model, system, tools, messages: session.deriveMessages(), signal}
      req = waterfall agent/request                   ⟵ hooks, model switch
      stream ctx.llm.stream(req)                      ⟵ waterfall llm/stream (raw chunks)
        session('assistant/chunk')
      if assembler.finish is error/aborted: throw      ⟵ adapter's in-band error path →
                                                         step error (turn ends error/aborted,
                                                         not a normal completed message)
      msg = waterfall agent/step-result               ⟵ runs BEFORE the log append, so the
      session('assistant/message' {content, usage?})     log records what tool dispatch uses
      each tool-call (sequential, abort-checked between calls):
        session('tool/call'); ctx.tools.execute()     ⟵ waterfall tools/pre-execute (allow/
          deny/ask gate) → dispatch → tools/post-execute (accept/block, replace, +context)
          tool execution may append tool-owned session events, e.g. `todo/write`
        session('tool/result')
      append buffered post-execute additionalContext → session('context/message')(s)
                                                         ⟵ after ALL tool/results (adjacency)
      drain steering → session('steering/message'); emit agent/steering
      session('step/end')                             ⟵ durable step boundary (no agent/* mirror)
      cont = waterfall agent/turn-continuation(default = {action: hadToolCalls||steered
        ? 'continue' : 'stop'}) → ContinuationDecision
      a continue's reason is recorded as next-step steering (same turn); steering pending
        also forces continue (continuation OR step/end listeners — the /goal pattern)
      if action==stop: break
  session('turn/end')                                 ⟵ durable turn boundary (no agent/* mirror)
  await ctx.parallel('session/flush', session)        ⟵ durability checkpoint (failure
                                                         reported via agent/error, not fatal)
  leftover steering re-enqueued as queued messages    ⟵ steering is never stranded
  emit agent/status(idle) unless more queued
```

Error containment: a throwing `agent/turn-continuation` listener or a broken step ends the **turn** with `turn/end { reason: { kind: 'error', step, message, code? } }` — the failure's step number rides on the durable turn reason (there is no separate session `error` event); live diagnostics fire via `agent/error`. Never the driver loop. An adapter that ends its stream with a `finish {kind:'error'}` or `{kind:'aborted'}` chunk (the in-band error path, for adapters that can't throw mid-stream) is likewise translated into a step error, so the turn ends `error`/`aborted` instead of logging a normal `completed` assistant message. A `cancel()` is honored mid-stream **and** between tool calls; disposal mid-turn ends the turn with reason `disposed` and emits `agent/status('disposed')`.

Turn-end reasons: a turn ends with one `TurnEndReason` — `completed`, `aborted`, `error`, `disposed`, `max-tokens`, `rejected`, or `interrupted`. `max-tokens` mirrors the model-call `FinishReason` of the same name (DeepSeek's `length`): a step that hit the output-token ceiling makes the turn end `max-tokens` rather than `completed`, by the rule *any `max-tokens` step in the turn surfaces as `max-tokens`* (a continuation plugin may run further steps after one, but the cut-short fact wins; the `disposed`/`aborted`/`error` outcomes still take precedence). `rejected` is a zero-step turn whose entire prompt batch was blocked by an `agent/prompt-submit` hook (the turn still opens and closes balanced; the ACP bridge maps it to `cancelled`). `interrupted` is synthesized by a persistence backend closing a crash-orphaned turn on reload. This lets a consumer distinguish a clean stop from a truncated/blocked one (the ACP bridge maps `max-tokens` to the `max_tokens` stop reason). `TurnEndReason` is merge-extensible; `refusal` and `max_turn_requests` are the next variants to add when an adapter/loop first emits them.

A failure that happens once the turn is already closed has no in-turn position for a turn-end error reason (the turn already ended). So a rejecting `session/flush` (the post-`turn/end` durability checkpoint) is reported via `agent/error` + the logger only, NOT as a session event; the turn stays balanced and the persistence backend keeps its buffered events for the next flush.

**Turn-enclosure invariant**: every session event lives inside a turn (between a `turn/start` and its `turn/end`). The loop appends queued `user/message` events *after* `turn/start`, and an idle `agent.inject()` wraps its `context/message` in a one-shot `injection` turn. This makes the turn the single durability/replay boundary: a persistence backend can treat anything after the last `turn/end` as an interrupted-crash tail without risking the loss of legitimately-recorded between-turn context. The `dsh-invariants` plugin enforces it in dev (a message event outside an open turn throws). See [the turn-enclosure invariant](rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md).

### Event taxonomy

The `agent/*` events are declared in `@deepseek-ai/dsh-agent` (so nothing depends on the loop package); each other service declares its own events (`tools/*`, `llm/*`, `system-prompt/*`, `session/*`). The full catalog — every event's exact signature, dispatch mode, and prose — is **generated from source** and lives in [cordis-catalog/events-and-services.md](cordis-catalog/events-and-services.md) (the `## Events` section), alongside the `ctx.<key>` service interfaces. That file is regenerated by `scripts/gen-cordis-catalog.ts` and frozen by the `verify-cordis-catalog` freshness gate (part of `doc-sync`), so it cannot drift from the `interface Events` declarations.

### Cordis waterfall semantics (important)

`ctx.waterfall` is **around-middleware**, not a value reducer. Each listener receives `(...args, next)`:

- call `next()` to delegate to later listeners (and ultimately the core behavior), possibly wrapping it;
- return a value **without** calling `next()` to short-circuit (veto);
- listeners run in registration order; `prepend: true` jumps the queue.

Composition caveat: values propagate through `next()`'s **return value**. Mutating the passed-in object works when later listeners receive the same reference, but a listener that returns a *new* object makes earlier mutations invisible downstream. Prefer mutate-then-`next()` for cooperative middleware; return a replacement only when you mean to take over the result.

## Plugin sanity checklist

Every MVP feature (including the TODO-marked ones), with the mechanism that implements it **without modifying the loop**:

| MVP feature | Plugin mechanism |
|---|---|
| Hook system (user + project level) | listeners on `agent/session-start`, `agent/prompt-submit`, `agent/request`, `agent/step-result`, `tools/pre-execute`, `tools/post-execute`, `agent/turn-continuation` (each interception waterfall returns a typed Decision); a hooks bridge plugin maps config files / shell commands onto those seams, a native hook plugin uses them directly |
| `/goal` | force-continue via `agent/turn-continuation` + `steer()` reminders |
| `/loop` | on the `turn/end` session event, `send()` the next iteration; or force-continue |
| Dynamic workflow | orchestrator plugin on the `turn/end` (or `step/end`) session event driving `send`/`steer` (+ sub-agents later) |
| Queued + steering messages | core `Agent.send()` / `Agent.steer()` |
| Context compaction (auto + manual) | the `dsh-compact` seam (`ctx.compact`) + a backend (`dsh-compact-basic`) on the serial `agent/pre-step` seam: a backend summarizes an older surface range into a single `user/message` `replace` op, bracketed by log-only `compact/*` events; auto = check token pressure before each step — runaway-turn survival, manual = a (deferred) `/compact` tool invoking the same `ctx.compact` routine. See the [compaction capability-seam RFC](rfc/implemented/feature/2026-06-18-compaction-capability-seam.md) |
| System prompt configurability | `ctx.systemPrompt.section()` with ordering |
| AGENTS.md (root) | a section provider reading the file |
| AGENTS.md (subdir, on-touch) + file-change notices | `agent.inject()` from a watcher / tool-result listener |
| Built-in tools (Read/Write/Edit/Bash/…) | `ctx.tools.register()`; schemas flow into the assembly automatically. **Bash: implemented** — `dsh-bash` (seam) + `dsh-bash-local` (subprocesses) + `dsh-tool-bash` (`bash`/`bash_output`/`bash_kill`, incl. background tasks). **`todo_write`: implemented** — `dsh-tool-todo` writes the whole task list to the session log (`todo/write`), rendered as a stdio checklist / ACP `plan` |
| ToolSearch / progressive disclosure | wrap `agent/request`, filter `req.tools` |
| Tool sandbox (landlock / sandbox-exec) | `tools/pre-execute` (deny), or implement a sandboxing `BashExecutor` (the dsh-bash seam) |
| Permission system / AskUserQuestion | `tools/pre-execute` (deny/ask); register an ask tool |
| Plan mode | `tools/pre-execute` (deny writes) + `agent/request` (inject mode prompt) |
| Sub-agent delegation | Implemented as the `ctx.subagents` provider-registry seam: `dsh-subagent-spawn` starts a fresh in-process child, `dsh-subagent-fork` seeds a child from the parent's completed-turn prefix, `dsh-subagent-acp` drives an out-of-process child over ACP, and `dsh-tool-subagent` exposes one configured provider to the model |
| MCP | one plugin per server: discover tools → `ctx.tools.register()` |
| Skills | section + tool registration; `inject()` skill content on invocation |
| Memory | section provider + tool |
| Scheduled tasks (cron) | plugin registers model-callable scheduling tools; timer fires → `send(…, {source: {kind: 'cron', …}})` when idle / `inject()` notification when busy |
| UI (GUI; CLI emits JSONL) | listen `session/event` (assistant chunks, boundaries, tool activity); input → `send()` |
| Telemetry / replayable trace | `session/event` → JSONL; replay = `sessions.create(id, { seed })` |
| DeepSeek V4 (and other) models | `LlmAdapter` subclass via `registerAdapter`. **Implemented twice**: `dsh-llm-deepseek` (hand-rolled) and `dsh-llm-pi-ai` (pi-ai-backed) |
| Plugin hot-reload | every registration is a `ctx.effect` → vendored HMR just works |

## Extension cookbook

Code skeletons for the three plugin shapes (tool, hook/permission-gate, UI) and the two runnable example wirings live in [docs/cookbook/extension-cookbook.md](./cookbook/extension-cookbook.md). Step-by-step guides: [adding a package](./cookbook/adding-a-package.md), [adding a tool](./cookbook/adding-a-tool.md), [adding an LLM adapter](./cookbook/adding-an-llm-adapter.md), [adding a vendored package](./cookbook/adding-a-vendored-package.md).

## Deferred work (TODO)

Tracked here deliberately — each is designed-for but not implemented:

- **Inter-agent channels beyond delegation** (shared state, streaming child output, background/poll semantics) remain out of scope for the current `ctx.subagents` seam.
- **Compaction** — the `dsh-compact` seam (`ctx.compact`) and the `dsh-compact-basic` backend exist (auto thresholds, summarization on the serial `agent/pre-step` seam, `compact/*` session events via declaration merging). The model-facing `/compact` consumer tool is still deferred. See [the compaction capability-seam RFC](rfc/implemented/feature/2026-06-18-compaction-capability-seam.md).
- **Parallel tool execution** (concurrency-safety hints on ToolDefinition).
- **Session branching/tree** (pi-style entry tree) if needed beyond seed-based forking.
