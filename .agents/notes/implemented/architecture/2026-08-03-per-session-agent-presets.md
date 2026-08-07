# Agent Note: A session's agent is composed from a preset cordis.yml

Status: implemented

English | [中文](2026-08-03-per-session-agent-presets.zh.md)

## Problem

One `dsh` process serves many sessions, but the composition that decides what an agent *is* — its tools, persona, prompt sections, delegation backends — is fixed for the whole process by the `cordis.yml` the launcher booted. A deployment that wants a benchmark-minimal agent beside a full coding agent has to run two processes, and the shipped workaround (`apps/cli/config/core-web.cordis.yml`, a `--config` overlay that disables tool rows) changes every session at once.

The obvious reading of "let a session pick its composition" is that the loader needs a new tier. It does not. [`dsh-tools`](../../../../packages/core/tools/README.md) and [`dsh-system-prompt`](../../../../packages/core/system-prompt/README.md) already file registrations into the calling context's scope layer, and [the agent is a registration scope](2026-07-08-agent-scope-contexts.md). What was missing is a way to point a whole `cordis.yml` at one agent's scope.

## Decision

A **preset** is a directory holding one `agent.cordis.yml`. The agent factory's `setup(agentCtx)` mounts it as a Cordis `include` subtree plugged into that agent's scope context. Entry contexts chain to the context a subtree was plugged into, so every registration inside the preset lands in that agent's layer and unwinds with the agent. No registry gains a tier, and no session already running is touched.

Composition splits into two planes, decided by what must be shared rather than by what feels agent-related:

| Plane | Instances | Contents |
|---|---|---|
| Host | one | The registries themselves (`tools`, `systemPrompt`, `agents`, `agent-loop`, `sessions`), cross-session facilities (persistence, query, projections, storage, settings, credentials, telemetry), and the web host |
| Agent | one per session | What a single agent contributes to those registries: tool plugins, persona and prompt sections, compaction policy |

Model routing stays out of presets. `installAgentLlmTarget` is already the per-agent seam for provider, model, and reasoning effort, and an LLM adapter mounted inside a preset would never be resolved by `agent-loop`, which lives in the host plane.

Mounting is per-session by default. Measured cost for a twelve-row composition is ~3ms and ~600KB per session, so isolation is the cheaper default than any sharing scheme, and a preset authored by a user or by an agent then has the smallest possible blast radius. A preset that genuinely owns an expensive singleton opts into sharing with Cordis's own `isolate` vocabulary: a named realm label is process-global, so two subtrees naming the same label resolve one instance.

Which preset an unnamed session gets is a user setting (`agent-presets.default`) layered over the composition's own `default`, which becomes the `base`. Both layers are needed: the composition value is what a deployment ships and must keep working with no settings provider at all, and the setting is what a person changes without editing a `cordis.yml` they may not own.

## Consequences

**The effective default is read per resolution, never snapshotted.** A cached value would need a `watch` subscription and a reload path to stay honest, and the resolved scope already re-reads a hot-reloaded document. Reading through is also what makes the boundary correct rather than merely cheap: the new value applies to the next session created, and every running session keeps the composition it was built from. That invariant is the same one the session header enforces from the other side — the header records the id a session actually runs, so a resume rebuilds that composition rather than today's default, and the gateway rejects an attempt to adopt a live session under a different one. A snapshot would make the two disagree at exactly the moment the setting changes.

**A directly-plugged subtree is invisible to the boot audit.** It never links itself to an `Entry`, so it is absent from `ctx.loader.entries()` and `assertEntriesActivated` cannot see it. The mount audits its own rows instead, reading the tree through an `Include` subclass that publishes it.

**A preset can only name a group because the app registers one.** Sharing a realm across rows is a `cordis:group` row, and a preset living outside this workspace — the authored ones under the Harness home, which is the point — cannot resolve `@cordisjs/plugin-group` by name: Node's upward `node_modules` walk never reaches the harness from there. `boot()` therefore registers `cordis:group` beside `cordis:include` as a loader builtin, so both load through the ambient module pipeline rather than through the included tree's own specifier resolution. Without it the `isolate` vocabulary above is expressible one row at a time only, and a provider could never be grouped with its consumers.

**A preset may not publish into the root service realm.** Such a service is process-global rather than per-session, so the second session mounting the same preset collides with the first — and the collision surfaces as an unhandled rejection that `setup` never observes, leaving a half-composed agent that looks healthy. The mount rejects it instead, and the package invariant re-checks on every service notification because a row publishing from a timer or an asynchronous continuation would escape a one-shot audit.

**Failure rolls the agent back.** `setup` runs before publication, so a rejected mount fails `ctx.agents.create()` and leaves nothing behind. This is why `setup` is the one supported call site.

**A test that the preset file is never rewritten has to be able to fail.** The first version asserted the file was unchanged after an ordinary mount, and could not have caught anything: the Loader only reaches its write path when it decides the config changed, and nothing in that composition ever self-disposed. The regression plants a row that disposes itself — the shape a real preset hits every time an agent is torn down — and keeps the composition in a temp root rather than under `fixtures/`, because without the override the Loader rewrites the file it read: a committed fixture would be damaged by the very run that proves the bug, and every run after it would compare against the damaged file and pass.

**Fiber membership is object identity, not `uid`.** A `uid` is a per-registry counter, so fibers in two different roots collide on it; comparing by `uid` made one runtime's subtree answer for a service published in another. `ctx.plugin()` returns a thenable `Object.create(fiber)` wrapper that is never identical to the fiber in a parent chain, so the subtree captures its own fiber during construction.

**The preset id is model-visible and must be logged.** It determines the tool set and prompt, so a resumed session has to restore the same composition; recording it is a session fact, not runtime state.

## Alternatives considered

**Add a preset tier to the scoped registries.** `ScopedLayers.merge()` combines the global layer with exactly one exact-scope layer. A middle tier would let many sessions share one mounted composition, but it changes `dsh-scope` and every scope-aware registry to save a cost measured in milliseconds, and it gives a preset's registrations a lifetime no agent owns.

**Make the agent's scope key the preset.** Sessions on one preset would share a layer for free, but per-agent registrations — `installAgentLlmTarget`, per-agent tool restrictions — would then collide across sessions.

**Run each preset as a child process.** [`subagent-dsh-sdk`](../../../../packages/subagent/subagent-dsh-sdk/README.md) already proves a full child harness works, and isolation would be absolute. It also means proxying streaming, approvals, and projections per session, which is a transport project rather than a composition one.
