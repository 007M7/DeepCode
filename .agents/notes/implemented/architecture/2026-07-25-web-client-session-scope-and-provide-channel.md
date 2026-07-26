# Agent Note: Web client session scope, the provide channel, and the intent data model (runtime scope / provide / before-create)

Status: implemented

English | [中文](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)

> Scope: the client session scope (sctx) and targeted events, session identity and materialize (the published bit), the intent data model (transactional submission), the per-session provide channel (`sessions.provide`), create-time contribution (`client-session/before-create`), the read-only queue mirror (`session/queued`), and the host wire that carries these capabilities (the apiproxy `commands`/`skills` domains, the `host/commands-changed` frame, and the host command registry's `requires` discriminant axis). The input state machine and the slash pipeline live in the [input machine note](2026-07-25-web-input-machine-and-slash-pipeline.md); the command business surfaces live in the [command surfaces note](2026-07-25-web-command-surfaces-and-assembly.md).

## Problem

The web client had a single global session surface: slots all rendered from the root context, so plugins had no notion of "which session is current"; the hero composer was one controlled update chain (`sessions.updateIntent → Session.updatePendingPrompt → notifyNow` same-tick echo) with the draft's true copy buried inside the Session object, leaving any plugin that wanted to participate in input with nowhere to hook in. To support a command/input system, the platform layer first had to answer:

- Who owns session interaction state (menus, popups, drafts, in-flight requests), and how two sessions are structurally isolated;
- How a new session keeps the same set of objects from Draft (a local Intent) to materialized (created on the host);
- How session-scope components fetch their own session data, instead of props passed down layer by layer;
- How business parameters at session creation (such as model choice) flow from individual plugins into the create request;
- The wire had nowhere at all to carry a command directory, execution, or the queue.

Hard constraints: the host is the single source of truth; every registration goes through a `ctx.effect` disposer; the scope mechanism matches the host's Agent scope architecture; model-visible ⟺ already in the session log.

## Decision

### Session scope: the sctx is the client session's sole carrier in the cordis world

Each client-session logical concept ⟺ exactly one cordis context (the sctx), paired bidirectionally with the business Session. The runtime's `sessions/scope.ts` matches the host's `dsh-scope` at the mechanism layer (fiber + tag + filter; no value import: the host package carries the scoped-events `Events` merge, which would collide with the Context merge inside the client program):

- `createScope(ctx, id)`: a no-op plugin fiber plus `extend({[kScope]: id, [Context.filter]: …})` — the filter lives directly on the sctx: untagged listeners receive globally, tagged ones receive only their own scope.
- Dispatch is the cordis primitives with thisArg = the sctx itself: `sctx.bail(sctx, event, req)` / `sctx.emit(sctx, event, payload)` (native emit does not swallow errors; the first synchronous throw propagates to the dispatcher — before-create's abort semantics come straight from this). The host's `scopeTarget` carrier + `agentEvents` wrapper layer above the mechanism is not copied on the client: that layer's job is welding the business Agent subject to the scope key against drift (host events inject the Agent itself as the first argument), while client event payloads carry only an id — there is no subject to protect.
- `Session.bindScope(sctx)`: paired exactly once when resolve mints the scope (rebinding throws; dropScope unbinds), mirroring the host's `Agent.loopCtx` — the Session uses it to dispatch its own scoped events. The reverse sctx→Session direction is one hop through `sessions.sessionOf(sctx)`.
- One deliberate divergence from the host: keys compare by branded `SessionId` value rather than object identity (a client session's identity IS its wire id).

Session instances share the scope's lifecycle:

- Liveness eligibility = host-listed ∪ the current Intent; mint (lazy first resolve — resolution is a pure function, render-safe) and prune share this single criterion.
- One prune tears down three things together: the Session instance, the scope fiber (cascading through every consumer hung on the sctx), and the session-keyed slot store. The staged session (= `list.current`) is the exception: removed while still on stage, it keeps a frozen read-only view, torn down only once the stage moves away.
- Reopening = lazily rebuilding the instance + `open()` pulling history (the host session log is the durable truth).
- Remaining TODO: approval/question frames never enter history and cannot be recovered across a prune (the manager-level pendingBuffers cover only the never-instantiated window).

id→ctx handoff is allowed in only three kinds of places (business providers never hand off):

- Slot inject factories: the ctx never enters the render layer; the identity the slot framework hands a component is the sessionId, exchanged back into objects/controllers through service maps.
- Root coordination services self-addressing: from a projection's sessionId back to the sctx via `sessions.scope(id)`.
- Root untagged listeners: looking up their own store by the payload's sessionId.

### Session identity and materialize: one published bit

- `Session.published`: a read-only getter, monotonic; `markPublished()` is the single CAS write point where three routes converge — the create response, the `host/session-added` frame, and attach-fail local publication. It does not mean the transport is online (`connection/reset` never lowers it).
- Materialize keeps the same set of instances throughout: the Session, the sctx, and every consumer on it are never replaced.
- Consumers subscribe to the Session snapshot and are driven directly by the published flip; no dedicated event exists.
- The `ClientSessionContext` projection (the runtime pure function `projectSessionContext(snapshot)`): `{sessionId, state:'draft', target:{workspace|workspace-intent}} | {sessionId, state:'materialized'}`; providers receive a fresh projection on every call, never cached.

### The intent data model: the draft steps aside, pendingPrompt demoted to a transaction record

The controlled chain (updateIntent/updatePendingPrompt/sendSession) is deleted with this rework. The draft's single truth moves to the input side (see the input machine note); the Session side keeps only the submit transaction:

- `connect(workspaceId, text)` receives the text snapshotted at the submit instant — `pendingPrompt` is purely the recovery record of this create/send transaction, no longer the draft's owner; failures surface through the snapshot and the input side does its own rollback.
- The workspaces side correspondingly keeps only `materializeIntent()` (Workspace intent → real Workspace); send orchestration moves wholesale up to the input side.

### Per-session provisioning: the `sessions.provide` standard-kit channel

The sole provisioning path by which session slot components fetch their own session data. Plugins declare a fixed key map through the static descriptor `sessions.provide({hooks, props, resolve})` (a duplicate key throws at registration); `resolve(binding)` materializes values for a specific session and tears them down with the scope. Web-react's `standardKit` single loop binds the hooks compartment into `use<Name>` selector hooks (`observableHook`→uSES, anti-tearing) and passes the props compartment through as-is.

Slot scope is the closed set `root | session-maybe | session`:

- `root` receives only the global standard kit, with no session identity or provisioning.
- `session-maybe` follows the current session, but the component instance does not change key when the id appears, disappears, or changes; with no session, `sessionId`, the results of `useSession`/`useInput`, and `inputActions` may all be absent. The unkeyed root `SessionMaybeProvider` drives these updates, while `SessionMaybeProvideInfo` uses the static key map to retain the complete hook/prop shape even with no session.
- `session` guarantees that `sessionId`, every hook source, and every prop exist; each strict entry's error boundary is keyed by `sessionId`, so switching sessions recreates that entry and its session store.

`conversation` is the resident `session-maybe` shell: `ConversationRoot`, HeroShell, Workspace picker, the composer stack, and the composer chain retain their React instances across the no-session → blank-session transition; `conversation.session` carries only the strict-session header/view, while the composer and every input slot also remain strict `session`. With no session, the composer stack places the presentation-only `DisabledInputBar` in the input slot; when a session appears, only that slot is replaced with the strictly bound InputBar. The textarea may be recreated; the Hero and layout skeleton are not.

- The runtime's first built-in entry: the `'session'` hook — `useSession` itself rides the same mechanism, no special-casing.
- Concurrent discipline: the render plane reads only from the hooks compartment (uSES consistency guarantee); props-compartment callbacks are used only in event-handler space; descriptor resolution is render-safe (idempotent caching, with prune reaping residue from abandoned renders).
- Third-party components take zero value dependencies; types are a one-line type-only import (declaration merging into `SessionStandardProps` / `SessionMaybeStandardProps`).

### Create-time contribution: `client-session/before-create`

- Declared in the runtime (@mode emit); **the Session self-dispatches inside attachPendingPrompt** (`sctx.emit(sctx, …)`, holding its own bound sctx); throw propagation from cordis's native emit IS the abort of this create; with the sctx unbound or already pruned, the contribution is skipped.
- Every create attempt (retries included) gets a fresh write-only typed builder: `SessionCreateOptionMap`'s first cut is `agent/provider` + `agent/model`; writing the same key twice throws; no opaque bag.
- The payload is `{sessionId, target, options}`; sessionId/target are read-only, and listeners write only the keys they own.
- Failure semantics: zero host calls; the draft / plugin stores / Intent are all preserved, the error lands in intent.error, and a retry uses a brand-new builder.
- The finalizer maps the typed keys into `sessions.create`'s `agentOptions` (the host schema is strict and rejects unknown keys; overriding the default provider/model passes through to `ctx.agents.create`).

### The read-only queue mirror

- The new MuxFrame `session/queued`: the Session holds a read-only inbox mirror (previews truncated; steering retired by source match); queue frames never enter history — pure stream state, cleared on reconnect and refilled from the new baseline; the never-instantiated window is buffered and replayed through the manager pendingBuffers.
- First-cut queue semantics: running does not lock input; ordinary messages queue through `session.prompt {mode:'queue'}`, and commands never queue.

### The host wire

- apiproxy adds two domains: `command.list {sessionId?}` and `command.execute {sessionId?, line}` (the signal travels out of band; `matched: false` is a business-level miss, not an error); `skill.list` is dual-addressed `{workspaceId} | {sessionId}` (the host resolves cwd from the workspace registry / the session entity, never through the Agent; querying an unattached session fails loud).
- The SSE frame `host/commands-changed` (a pure invalidation signal); the client routes it into the typed events `commands/changed` and `connection/reset` (broadcast after each connection generation is established; wire-derived caches uniformly treat prior state as stale).
- The host `CommandDefinition` is a two-arm union: `requires:'none'` (the handler receives an AgentlessInvocation) | `requires:'agent'` (it receives a CommandInvocation). No default; registering `'none'` at agent scope fails loud at register. `list()` returns only global-layer none; `list(agent)` returns the effective view. /plan, /goal, and all TUI commands are `requires:'agent'`.
- Client payload rules: none never carries a sessionId; agent requires a published session with a stable id — a missing one fails loud, never auto-creates.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Passing session context down through React Context | Plugins should hold one mental model across host and client; the scope mechanism is isomorphic to the host dsh-scope |
| A dedicated host-connected event | Consumers are all per-session objects already subscribing to the snapshot; the published flip drives them directly — a one-shot event must not pose as state truth |
| A `scopeTarget` carrier + fused dispatcher (mirroring the host `agentEvents`) | The host wrapper layer guards the business Agent subject against drifting from the scope key; client events have no subject to guard — the filter on the sctx plus cordis primitives covers every need |
| Sessions not holding a ctx (a cordis-free object layer) | A red line born only so the filtering unit tests avoid importing cordis, at the cost of two-hop contribute callbacks plus mutable public fields; the host Agent already holds loopCtx |
| A separate lightweight ClientSession object | published is already the Session's CAS bit; two sources of truth violate single authority |
| Resident Session instances (resident-instance) | The host session log is the durable truth; residency is mere identity convenience, and its misalignment with the scope lifecycle is a source of complexity |
| Components receiving wiring-callback bundles (two-layer inject→props pass-down) | The standard-kit channel lets components fetch their own; the public surface converges to hooks + stable props |
| Swapping the no-session Hero view for the entire session Conversation | Even with the outer layout unchanged, the Hero, picker, and composer subtrees would remount together, making the whole UI region jump |
| Making InputBar itself `session-maybe` | The input state machine, keyboard command surface, and actions would all have to accept absent values; replacing only the disabled input body keeps optionality at the shell boundary |
| Create options through an opaque bag | The typed write-once map keeps listener order meaningless and duplicate writes failing loud |
| A requires default, or reserving an 'optional' arm | Pre-release fills it in one pass; the both-states arm has no owner and is not reserved |
| A runtime RPC namespace registration seam | The compile-time-closed method table is the auditable boundary |

## Consequences

- Plugins gain session context isomorphic to the host's: per-session state hangs on the sctx and mounts/tears down in one piece with the scope fiber, making leaks structurally impossible; two-session isolation is structurally guaranteed by the scope filter.
- With draft ownership moved out, the Session object layer converges to a wire mirror plus the submit transaction, freeing the input system (the next layer) to evolve independently.
- The before-create channel turns "create a session with business parameters" into a single listener registration; the first business consumer is model selection (see the command surfaces note).
- The cost: the id→ctx handoff discipline and provide's Concurrent discipline are conventions rather than type-enforced, pinned by review and tests.
- Known gaps: approval/question recovery across prune (TODO); the unattached skill.list semantics await a ruling.
