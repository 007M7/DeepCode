# RFC: Session modes — plan mode as logged per-agent policy state

Status: proposed

English | [中文](2026-07-07-session-modes-plan-mode.zh.md)

## Problem

The harness has no way to put an agent into a reduced-authority working state. The canonical feature that needs one is plan mode — the agent explores and designs under a read-only tool policy, produces a reviewable plan, and crosses back into full authority only through an explicit approval. [The extension cookbook](../../../cookbook/extension-cookbook.md) already reserves the row ("Plan mode — `tools/pre-execute` (deny writes) + a mode prompt section"), and [the ACP feature matrix](../../../../packages/ui/acp/acp-feature-support.md) records session modes as a known gap both reference adapters ship (Claude's plan auto-mode, Codex's read-only / agent / full-access presets). Neither says where the mode STATE lives, how it survives resume and fork, or how its model-visible consequences stay honest with the session log.

A survey of shipped plan modes (Claude Code, Cursor, Copilot, OpenCode, Gemini CLI, Cline, Windsurf, Codex) shows the same five parts everywhere: a low-authority tool policy, a plan artifact, an approval moment, an execution-state switch, and durable state. Four of the five already exist here as gated infrastructure: what the model is TOLD it can do is shaped per step at [`system-prompt/assemble`](../../../../packages/core/system-prompt/README.md) and whatever ships is logged as `request/header*` events ([reconstructability](../../implemented/architecture/2026-07-05-reconstructable-requests.md)); what can RUN is gated at `tools/pre-execute` with typed decisions ([interception seams](../../implemented/feature/2026-06-30-interception-seams.md)); the approval moment is the `ask` vocabulary, serviced by the approval seam (`docs/rfc/proposed/feature/2026-07-06-approval-seam.md`, in flight on `feat/sandbox-support` as this is written — link it on merge); durable per-agent facts are `SessionEventMap` members ([the `todo/write` precedent](../../implemented/feature/2026-06-29-todo-write-tool.md)). The missing fifth is the mode itself: a named, durable, per-agent policy state the policy listeners can read.

The ecosystems that leave modes to convention show the failure shapes to avoid. Pi-style mode extensions fight over a last-wins global active-tool list, enforce "read-only" by prompt text alone (a hallucinated call to a still-registered tool executes), and re-inject plan state into every request to survive compaction. Each of those holes closes structurally here — but only if the mode is logged session state, not plugin-private memory.

## Proposal

A **session mode** is a named, logged, per-agent policy state. Mode definitions — which tools stay visible, what guidance section renders — are deployment config; the mode IN FORCE for an agent is session state, folded from its log. One new product package, `@deepseek-ai/dsh-mode` at `packages/mode/mode/` (a new top-level group, the `packages/approval/` shape), owns the event vocabulary, a thin `ctx.modes` service, and every policy listener; the loop does not change. The harness ships exactly one built-in definition: `plan`.

### The mode state is a session event

`dsh-mode` declaration-merges **`mode/set`** into `SessionEventMap`: a log-only, non-surface event carrying `{ mode: string }`, whole-value-replace semantics like `todo/write`. A pure `foldMode(events)` returns the mode in force — the last `mode/set`, or the default mode when none exists — and the plugin caches the fold per session with a lazy cursor (the `foldRequestHeader` idiom). Because the event is log-only it never enters the model transcript, and because it is not a surface node compaction can never shadow it: the fold sees the whole log on live sessions, resume, and fork alike. Per [event-domain semantics](../../implemented/architecture/2026-06-30-event-domain-semantics.md) the log is the fact channel, so mode state needs no live `agent/*` mirror — UIs read `mode/set` off `session/event`.

The default mode is the absence of policy: no section, no filtering, no gate. An agent that never sees a `mode/set` behaves byte-identically to a deployment that never loads `dsh-mode` — which keeps every existing snapshot golden stable and makes the plugin safe to compose unconditionally.

### Two layers of enforcement

**Soft — what the model sees.** A `system-prompt/assemble` waterfall listener reads the calling agent's mode (the `AssembleContext` carries `agent`) and, in plan mode, filters `assembly.tools` down to the mode's allowlist and appends the mode's guidance section. The loop already renders per step and logs the result: entering or leaving a mode surfaces as a `request/header-delta` on the next step, so every mode transition is an attributable, diffable log fact and the [reconstructability](../../implemented/architecture/2026-07-05-reconstructable-requests.md) invariant stays green by construction. The section is static per mode and the plan itself stays in the conversation (messages and tool args, already in context), so a mode does not add per-step prompt churn — the pi-style "re-inject the plan file every request" hack is unnecessary and would only burn prefix cache.

**Hard — what can run.** A `tools/pre-execute` listener denies, with a mode-naming reason that steers the model back to planning, any call outside the mode's allowlist. This layer is not redundant with the filter: [`ToolRegistry.execute()`](../../../../packages/core/tools/README.md) dispatches any registered tool by name, so a model hallucinating a filtered-out (or MCP-registered) tool would still run it without the gate. Deny-by-default against the allowlist also means the two layers cover each other — a peer `assemble` listener that re-widens the schema set cannot make the widened tools executable. An agent-less execution (no session to fold) passes through, mirroring the approval seam's agent-less degrade.

### Mode changes and turn enclosure

Two writers flip the mode. A **tool** (`exit_plan_mode`) appends `mode/set` from inside its own execution — already turn-enclosed, the `todo/write` path. A **user** flips it through `ctx.modes.set(agent, mode)` (a stdio command, ACP `session/set_mode`), and that path cannot append immediately: [every session event is turn-enclosed](../../implemented/architecture/2026-06-15-turn-enclosure-invariant.md), and an idle agent has no open turn. The service therefore records a pending intent and flushes it as the first append after the next `turn/start`. Sequencing makes this correct for the request the turn sends: the loop assembles the prompt after the turn opens and before each step, so a flush at `turn/start` is folded by step 1's assembly, while a mid-turn flip lands at the next boundary and takes effect on the following step — the same "applies to subsequent requests" semantics every surveyed product ships. A user flip is also **narrated**: when the flushed mode differs from the fold at the last `request/header`, the service appends one coalesced notice in the same frame ("The user switched this session to plan mode."), so a net-zero flip sequence narrates nothing, a tool-driven exit narrates through its own tool result instead, and a mode set before the first turn narrates nothing (the section is the state statement) — the boundary-narration principle of the in-flight env-state proposal (`docs/rfc/proposed/feature/2026-07-06-env-state-visibility.md`): a silently flipped prompt surface leaves the transcript arguing from a state the header no longer has. The cost is honest and bounded: a pending intent set while idle is lost if the process dies before the next turn (the UI that set it still holds it and re-applies); promoting user flips to a durable idle-time fact would need a generalized idle-record primitive, which stays out of scope until the loss proves real.

### The plan artifact and the exit tool

The model-facing **`exit_plan_mode`** tool closes the loop, visible only in plan mode (the assemble filter adds it there and drops it elsewhere; the pre-execute gate denies it outside plan mode). Its single argument is the plan text — which makes the plan a durable, replayable log artifact riding the ordinary `tool/call` event, with no parallel plan-file store to invent or drift. Its [render intent](../../implemented/architecture/2026-07-02-tool-render-intent-union.md), decided up front: a `generic` call card titled by the plan's first heading with the plan markdown as content, and a `generic` result card. The approval moment is not new machinery: the mode gate returns `ask` for this one call, the approval seam routes it (ACP: `session/request_permission` attached to the streamed call, one-shot allow/reject), `allowed-once` lets the tool body append `mode/set` back to the default mode, and every other outcome becomes the corrective `isError` that tells the model to keep planning. Execution tracking after approval is already covered by `todo_write`. A deployment that composes no answerer keeps a safe but manual shape: the gate's `ask` resolves `unavailable` and denies (the seam's fail-closed default), so the exit degrades to the user toggling modes — never to an unapproved exit.

### Package shape

`dsh-mode` is one product package, not a capability-seam trio — there is no swappable implementation; the variable parts are config values and the fixed listeners ([capability seams](../../implemented/architecture/2026-06-13-capability-seams.md): don't split preemptively; the approval seam made the same call). It is more than an [fs-policy-style](../../../../packages/fs/fs-policy/README.md) pure event-gate plugin only because UIs need a call surface: `ctx.modes` exposes `list()` (the configured definitions, for a mode picker), `get(agent)` (the fold plus any pending intent), and `set(agent, mode)` (validate against config, record intent, flush at the boundary). Everything else participates through listeners, so dropping the package gracefully removes modes rather than breaking a consumer.

Mode definitions are validated plugin Config — per repo convention (changeable from `cordis.yml`, no code edit): each names its tool allowlist and its section text, and `plan`'s shipped default allowlist is the read-only surface (`read`, `todo_write`, `web_search`/`web_fetch`, `exit_plan_mode`) with `bash` and `subagent` excluded until the sandbox family can actually confine them. `AgentOptions` is merge-extensible, so `dsh-mode` declares an optional `mode` field: a creator (or a subagent provider forwarding its parent's mode) seeds the child's initial mode, applied through the same pending-intent flush on the first turn.

### Protocol and UI surfaces

The stdio app gains a mode toggle command, a banner line, and a readline answerer on the approval waterfall, so the exit approval prompts right in the terminal (riding the in-flight user-interaction stdio provider's one-prompt-owns-stdin queue where that seam is mounted — a yes/no confirm is a degenerate single-select — and raw readline otherwise). On ACP, the mode PICKER is this package's surface: `session/new`/`session/load` advertise `availableModes`/`currentModeId` from `ctx.modes` (consumed opportunistically via `ctx.get`, the `tool-bash` pattern), `session/set_mode` calls `set()` and notifies `current_mode_update` optimistically (the pending mode IS the user's selection; the logged `mode/set` follows at the boundary), and a `session/event` listener re-notifies on each logged flip that differs from the last sent. Individual environment knobs — sandbox mode, approval policy, the model — are NOT modes: they belong to `session/set_config_option`, and the in-flight env-state proposal's config-phase sketch, which currently routes `set_mode` to env facts, is the ONE overlap between the two proposals — the division proposed here is picker-to-modes / knobs-to-config-options, a mode definition may later bundle env facts (applied through `ctx.envState` where mounted) so a Codex-style preset stays a single mode, and whichever proposal lands second amends its wiring to match. The exit tool's approval needs no new ACP work at all — it rides the approval seam's answerer.

## Detailed design

### Vocabulary

```text
'mode/set': { mode: string }        // SessionEventMap merge in dsh-mode: log-only, non-surface,
                                    // whole-value replace — the last one in the log wins
DEFAULT_MODE = 'default'            // the fold of a log with no mode/set; reserved, not definable
```

The payload carries no reason/provenance field: a tool-driven flip sits next to its `tool/call` in the log and a user flip sits at its turn boundary, so the cause is log-adjacent — the same "narrative fields are derivable" call the [reconstructability RFC](../../implemented/architecture/2026-07-05-reconstructable-requests.md) made for header deltas (the in-flight `env/state` event carries a `source` precisely because its drift variant has NO log-adjacent cause — a contrast, not a conflict). Mode names are config-declared vocabulary, not opaque cross-boundary ids, so they stay bare strings (no `Branded<B>`).

### Config and the resolve step

```text
interface ModeDefinition { section: string; tools: string[] }   // prompt text; allowlist of tool NAMES
interface ModeConfig { modes?: Record<string, ModeDefinition> } // plan's built-in definition merged unless overridden
resolveConfig(config): ResolvedModes                            // explicit resolve (the dsh-bash template), fail-loud:
                                                                // 'default' as a key rejected; allowlists may name
                                                                // not-yet-registered tools (registration is dynamic)
```

The allowlist is deliberately the degenerate form of a future per-tool decision map (`allow | deny | ask`): execution-phase ask policies (an every-write-asks "guarded" mode) stay deferred until the approval seam grows durable grants (`allow_always` — its own open question), and the config shape must not need a migration when they arrive.

### The fold, the service, and the flush

`foldMode(events)` is pure (exported for reconstructors and tests); the service tracks it per session with a lazy cursor in a `WeakMap<Session, { cursor, mode }>` — O(new events) per read, never invalidated, because the log is append-only and `mode/set` is not a surface node (compaction cannot rewrite it). `ctx.modes` (a cordis Service, key `modes`) exposes `list()` — the synthetic `default` entry plus the configured definitions, for pickers — `get(agent): { current, pending? }`, and `set(agent, mode)`, which validates the name against config, drops a no-op (target equals pending ?? current), and otherwise records the intent in a `WeakMap<Session, string>`. A contained `session/event` listener ([defensive patterns](../../../defensive-patterns.md): a policy plugin must not kill the feed) flushes the pending intent as a `mode/set` append on the next `turn/start` or `step/end` — both sit outside the step's tool-execution window, so the executions of a step always run under the mode its assembly folded — and, when the flushed mode differs from the fold at the last `request/header`, appends the one coalesced `context/message` notice in the same frame. Seeding rides `agent/created`: a declaration-merged `AgentOptions.mode` becomes a pending intent, so explicit options beat the logged baseline on create AND resume — the same precedence the call-config seed follows — while a fork child needs no mechanism at all (the parent's `mode/set` is inside the seeded prefix).

### The soft layer: a computed section and a post-`next()` filter

The guidance section is an ordinary registered section, `{ name: 'mode:policy', order: 50, text: context => … }` — order 50 sits after the persona (0) and before tool guidance (100–199); it resolves to the folded mode's configured text and to `''` (dropped at render) for the default mode or an agent-less assembly. The tool filter is a `system-prompt/assemble` waterfall listener that wraps: it awaits `next()` and filters the RETURNED assembly's `tools`, so additions made anywhere inside its wrap are covered. The filter enforces one rule in every mode: `exit_plan_mode` is visible IFF the agent's folded mode is `plan` — which is also what keeps a default-mode assembly byte-identical to a no-`dsh-mode` deployment even though the tool is always registered. In a non-default mode it additionally intersects with the mode's allowlist.

### The hard layer: the gate

```text
tools/pre-execute: no exec.agent → next()          // agent-less calls have no session to fold
                   folded mode = default → next()
                   exec.name = exit_plan_mode:
                     plan mode → { kind: 'ask' }    // the approval moment; the registry routes it
                     otherwise → deny
                   allowlisted → next()
                   otherwise → deny                 // reason names the mode and points at exit_plan_mode
```

The gate folds the LOGGED mode only, never the pending intent — enforcement judges by the same state the request's header shipped under. Because the `ask` is produced here and resolved by `ToolRegistry.execute()` through `ctx.approval`, `dsh-mode` takes no dependency on the approval package; a deployment without the seam gets the registry's fail-closed degrade.

### `exit_plan_mode`

`defineTool` with one required `plan: string` argument. `execute` rejects an agent-less call (the [`todo_write` precedent](../../implemented/feature/2026-06-29-todo-write-tool.md)), re-checks the folded mode as defense in depth, appends `mode/set { mode: 'default' }` in-turn, and returns a short confirmation; the next step's assembly restores the full toolset and logs the widening `request/header-delta`. `presentCall` is a `generic` card carrying the plan markdown as content — the approval prompt attaches to this already-streamed call by `callId`, so what the human approves is exactly the logged artifact. A rejection reaches the model as the registry's "user rejected" `isError`, and it revises and re-presents.

### Dependencies and surfaces

`dsh-mode` peers on `cordis`, `dsh-session`, `dsh-agent`, `dsh-tools`, `dsh-system-prompt` (manifest shape mirrors `dsh-tool-todo`), injects `['tools', 'systemPrompt']`, and depends on neither the approval package nor any UI. The stdio app adds a `/mode [name]` line-handler branch (print or switch + banner, never sent to the model) and the readline answerer for its own agent. The ACP wire mapping is pinned in Protocol and UI surfaces; package-wise the bridge takes a type-only peer edge on `dsh-mode` and reads the service opportunistically, so a bridge without the plugin behaves exactly as today.

### The recorded scenario and the harness op

`input.json` gains one step op, `{ "op": "setMode", "mode": "plan" }`, driven through the real `session/set_mode` RPC. The `plan-mode` scenario: initialize → newSession → setMode(plan) → a prompt that explores and attempts a `write` (denied by the gate, pinned verbatim) → the model presents the plan via `exit_plan_mode` → a scripted `permissionAnswers` approve → a follow-up prompt that writes for real. Because the mode is set before turn 1, the FIRST `request/header` snapshot is already in plan shape (filtered tools + section, reason `initial`) — the widening delta appears at the exit; the scenario pins both, plus the `mode/set` pair. A sibling `plan-mode-reject` scenario scripts the reject and pins the corrective result. Both need a with-key recording session; the deny/reject texts are meanwhile pinned at the unit tier (the approval RFC's same stance).

### The mechanical tail

No new cordis event is declared (`mode/set` rides `session/event`; the listeners attach to existing waterfalls), so the events catalog is untouched; regenerated in the same change: the persistence log catalog (`mode/set`), the services catalog (`ctx.modes`, JSDoc-complete), the config catalog (`ModeConfig`), the tool catalog (`exit_plan_mode`), the producer/consumer map and doc graphs, and the module graph. Repo plumbing: a root tsconfig `paths` entry, the new group's README plus a [packages map](../../../../packages/README.md) row (a new top-level group is the deliberate act that table names), an `architecture.md` capability-services row for `ctx.modes` (budget-checked), and the cookbook row upgrade.

## Roadmap

Plan mode is one feature and lands as one. An agent that can be locked into planning but has no sanctioned way to propose leaving it is not a smaller version of the feature — it is a different and worse one, where every plan ends with the model asking the user to flip a switch it cannot see. The two stages below are therefore build-and-review order for one stacked landing ([stacked-review guide](../../../cookbook/responding-to-pr-review-on-a-stack.md)): stage 2 stacks on stage 1 and the stack merges together; neither stage is a shippable milestone on its own.

The one hard prerequisite is the approval seam (`docs/rfc/proposed/feature/2026-07-06-approval-seam.md`): the exit approval is its `ask` routing end to end. It is already implemented on `feat/sandbox-support`, so the coupling is merge order, not unbuilt work — this stack bases on that branch until it lands on master. The wider in-flight neighborhood is convergent, not conflicting: the sandbox-escalation branch ships the first live approval composition (its example and scripted-answer harness are the precedent our recorded scenarios follow), the env-state proposal pins the same fold-from-log + boundary-application idiom for environment facts (its `session/set_mode` config-phase sketch is the single coordination point, resolved in Protocol and UI surfaces), and the user-interaction seam supplies the stdio answerer's stdin discipline where mounted.

### Stage 1 — the mode core

The `dsh-mode` package: `mode/set` + `foldMode`, the assemble filter and mode section, the pre-execute gate, validated Config with the `plan` definition, `ctx.modes` with pending-intent flush, the `AgentOptions.mode` merge, and the stdio toggle. Coverage named at plan time: unit tier for the fold, the filter, the gate matrix, the flush mechanics, and the coalesced boundary notice; a snapshot scenario pinning `mode/set` plus the consequent `request/header-delta` in `session.jsonl`; all existing goldens byte-identical (default mode is invisible). Docs tail in the same stage: package + group READMEs, the [packages map](../../../../packages/README.md) row, regenerated persistence/config catalogs, and the cookbook's plan-mode row upgraded from sketch to package pointer.

### Stage 2 — the exit loop and the protocol surface

`exit_plan_mode` (ask-gated, plan-carrying, render intent as specified), the stdio readline answerer, and the ACP session-mode mapping (`session/set_mode`, `current_mode_update`, advertised available modes). Coverage: unit tier for the ask routing and both outcome paths plus the stdio answerer; a recorded snapshot scenario driving approve and reject through the harness's scripted `permissionAnswers`; the ACP mode round-trip in the bridge's protocol tests.

Deferred beyond this landing, each behind its own decision: subagent mode inheritance via a forwarded `AgentOptions.mode` (the option field itself ships in stage 1), per-tool `ask` policies inside mode definitions (an OpenCode-style "bash asks in plan mode"), preset modes beyond `plan` (read-only, accept-edits), sandbox-backed bash confinement in plan mode, and the idle-record primitive if pending-intent loss proves real.

## Alternatives considered

**Permission modes as the concept (the Claude Code shape).** One `permissionMode` fusing approval policy and tool policy. Here those are two axes with two owners: the approval seam owns "who answers this question", modes own "what surface does the model get". ACP models them as related but distinct (a mode may select an approval policy later — a mode definition gains a field, not a merger).

**A capability-seam trio.** Interface/implementation/consumer fits a swappable backend; a mode's variable parts are config values, not implementations. Splitting would manufacture an empty implementation package — the same "don't split preemptively" call the approval seam and [`todo/`](../../implemented/feature/2026-06-29-todo-write-tool.md) made.

**Loop-owned mode state.** Rejected on the standing rule (plugins, not loop changes): every hook the feature needs — assemble, pre-execute, turn boundaries, session events — is already a documented seam, so a loop edit would buy nothing but coupling.

**Prompt-only plan mode (no hard gate).** The Pi failure shape: filtering schemas (or asking nicely) does not stop a dispatch of a still-registered tool. The pre-execute gate is the enforcement layer; the filter is UX and cache hygiene.

**Runtime-only mode (UI- or bridge-local, unlogged).** Resume and fork would silently drop the mode, and the header deltas a mode causes would have no attributable cause in the log. Logged state is what makes the mode auditable and restorable for free.

**Mode flips as `context/message` via `agent.inject()`.** Reuses an existing turn-enclosure path, but puts policy state into the model transcript — the model does not need to be told twice (the section already tells it), and a log-only fact should not occupy surface.

**A plan-file store (`.plans/` directory).** A second durable home for what the log already carries replayably; a deployment wanting files can add a tool that writes them. One home per fact.

**A boolean `planMode` instead of named modes.** Too narrow for the surface the repo already tracks (ACP advertises a mode LIST; Codex ships three), and generalizing later would rename the event vocabulary. The generic mechanism costs nothing extra now; only `plan` ships as a definition.

**A tool-policy-stack service (the Pi-critique remedy).** A dedicated composition service for tool policies is premature: waterfall listeners compose by construction, and the deny-by-default hard gate makes filter-order races non-exploitable. Formalize only if real conflicts appear.

**Exit by prose or steering instead of a tool.** No artifact and no approval moment — the tool's argument IS the reviewable plan, and its `ask` is what gives the human a structured yes/no attached to the exact transition.

## Acceptance criteria

- The mode in force is a pure function of the session log: resume and fork restore it with no extra machinery, and a `mode/set` is followed by the matching `request/header-delta` on the next step with the dev invariant green throughout.
- A user-driven flip narrates exactly once at the next boundary and a net-zero flip sequence narrates nothing; a tool-driven exit narrates only through its tool result.
- In the default mode the plugin is invisible: assemblies are byte-identical with and without `dsh-mode` loaded, and every pre-existing snapshot golden is unchanged.
- In plan mode the filtered schemas and mode section reach both the wire request and the logged header; a call to a registered-but-filtered mutating tool is denied at `tools/pre-execute` with the mode-naming reason.
- Mode definitions (allowlist, section text) are changeable from `cordis.yml` with no code edit; an unknown mode name fails validation loudly at `set()` time.
- `exit_plan_mode`'s approve path flips the mode and restores the full toolset on the next step; the reject path returns the corrective `isError` and stays in plan mode; both are pinned by a recorded snapshot scenario through scripted permission answers; the ACP `session/set_mode` round-trip updates `current_mode_update`, and the stdio answerer prompts in the terminal.
- The docs tail shipped with the landing: READMEs, regenerated catalogs (persistence log, config, cordis services), and the cookbook row.

## Risks

A pending user flip set while idle is lost if the process dies before the next turn — accepted (the UI re-applies; the idle-record primitive is the escape hatch if this bites in practice). Every mode transition is a logged header change and therefore a prefix-cache reset at the provider — inherent, visible in per-step usage, and an argument against mode-flapping UIs, not against the design. Sibling-listener order is not deterministic, so a foreign assemble listener wrapping OUTSIDE the mode listener could re-widen filtered schemas — the filter runs on the assembly `next()` returns (so everything inside its wrap is covered), and the hard gate keeps anything re-widened non-executable; the residual cost is cosmetic (the model sees a tool it cannot use), accepted rather than mechanized. Plan mode's shipped allowlist excludes `bash` and `subagent`, which costs real exploration power (no `git log`, no read-only delegate) until the sandbox family and mode inheritance land — a deployment that accepts the risk can widen its own config today. The whole landing gates on the approval seam merging first — a deliberate schedule coupling accepted in place of shipping the mode core alone (an incomplete feature, per the roadmap); the seam is implemented on its branch, and this stack bases on it meanwhile. A deployment that composes no answerer keeps a safe but manual plan mode (`ask` → `unavailable` → deny), and the mode section tells the model to present its plan through `exit_plan_mode` — and to ask the user if that is denied — so it never thrashes against the gate. Two in-flight proposals touch the ACP mode surface (this one and the env-state config phase): the picker-to-modes / knobs-to-config-options division in Protocol and UI surfaces is the proposed contract, landing order decides who wires `session/set_mode`, and the second lander owes the amendment. Branch-heavy policy code under the per-file 100% coverage gate is real work, accepted as the ACP bridge did.
