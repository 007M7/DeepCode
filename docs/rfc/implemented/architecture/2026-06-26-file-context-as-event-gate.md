# RFC: Make `dsh-fs-policy` an event-gate plugin, not a method interface

Status: implemented

## Problem

[The split-fs-seam RFC](../simplification/2026-06-26-fsspec-style-fs-seam.md) put `ctx.fileContext` between the model-facing tools and the `ctx.fs` provider: `dsh-tool-fs` injects `fileContext` and routes every `read`/`write`/`edit` through its methods. That makes `fileContext` **in-path and mandatory**. The tool cannot reach `ctx.fs` without it, the policy layer owns the fs I/O and the read windowing, and a deployment that does not want observed-state policy cannot simply drop the package — `dsh-tool-fs` would fail to resolve `ctx.fileContext`.

This couples three things that should be separable:

1. **What the tool does** — resolve a path, read a window, write/edit a file. This is the tool's job and needs only `ctx.fs`.
2. **The freshness/observation policy** — "edit requires a prior read", "write/edit must be based on the version you read". This is the `dsh-fs-policy` plugin's job.
3. **The recording of observed state** — a side effect that should never block the tool from functioning.

Because the tool calls `fileContext` methods, removing the policy layer is a breaking change rather than a graceful loss of an *add-on*. The policy is load-bearing for the tool to even run, not an opt-in tightening.

## Decision

Invert the control flow. **`dsh-tool-fs` becomes the executor and calls `ctx.fs` directly**; **`dsh-fs-policy` becomes a gate + recorder plugin** that participates through events, never through a method the tool calls and never by registering a `ctx.fileContext` service.

```text
tool          dsh-tool-fs       executor: resolves, reads windows, writes/edits via ctx.fs;
                                emits fs policy events; renders results
policy        dsh-fs-policy  plugin: listens to fs/write-intent +
                                fs/edit-intent (single-slot waterfall) and fs/observed
                                (emit) events; adds observed-state + freshness.
provider seam dsh-fs            ctx.fs: text IO + ATOMIC mutation primitives whose version
                                guard is OPTIONAL; owns the fs policy event vocabulary
provider      dsh-fs-local      local implementation of ctx.fs
```

The model is **additive, not subtractive**: `ctx.fs` on its own is a complete, unconstrained text-storage seam — `read` reads, `write` unconditionally creates-or-overwrites, `edit` unconditionally replaces literal text in the current content. There is no "先读后写", no version check, nothing to remove; the bare provider just does the I/O atomically. `dsh-fs-policy` is a plugin that *adds* constraints on top: observed-state, read-before-edit, and "write/edit must be based on the version you read". So removing `dsh-fs-policy` does not break `dsh-tool-fs` at the service-injection boundary; it removes the policy gate and leaves the bare provider behavior. The intended deployment stance is that a config loading the fs tools also loads `dsh-fs-policy`, so the user-facing behavior and prompt discipline are read-before-write/edit (the `coding-agent` and `acp-agent` demos wire the full stack). The bare-provider mode exists because the tool should not be method-coupled to the policy plugin, not because an unconstrained filesystem is the normal product stance.

`dsh-tool-fs` no longer injects `fileContext`. It injects `fs` and `tools`/`systemPrompt`.

## The policy is enforced by provider CAS, not by `dsh-fs-policy` stat

`dsh-fs-policy` enforces "you must write/edit based on the version you read" **without ever calling `stat` or comparing versions itself**. It supplies the observed version as the CAS basis and lets the provider's mutation critical section detect staleness:

- "Have you read this file?" is the one thing `dsh-fs-policy` decides locally — a `WeakMap` lookup, no I/O. No record ⇒ `FS_NOT_OBSERVED`.
- "Is the version you read still current?" is decided **inside `ctx.fs.editText`/`writeText`**, in the same atomic lock that performs the read-match-rename. `dsh-fs-policy` passes `vObserved` as the expectation; the provider raises `FS_STALE_VERSION` if the file has moved on.

This is deliberate. If `dsh-fs-policy` stat-ed and compared versions in its waterfall handler, there would be a TOCTOU gap between that check and the tool's actual write — the file could change in between, so the check would be a false guarantee that the provider's lock has to back up anyway. Putting the version check in the provider's critical section is both race-free and zero extra `stat`. So `dsh-fs-policy` does **no** filesystem I/O; the "must be based on the latest read" guarantee is *realized* by CAS, and `dsh-fs-policy` only chooses the basis (`vObserved`) and gates on prior observation.

## Provider contract change: the version guard is optional

For the bare provider to be unconstrained, the version guard on its two mutations becomes **optional** — present ⇒ guarded, absent ⇒ unconditional:

```ts ignore-check
// writeText: expected is now optional. The FsWriteIntent union is UNCHANGED.
writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>
//   undefined          → unconditionally create-or-overwrite (bare default)
//   createIfAbsent     → create only, reject an existing file (dsh-fs-policy, unobserved)   [unchanged]
//   replaceIfVersion   → overwrite only at the observed version, else FS_STALE_VERSION    [unchanged]

// editText: expected becomes optional (was the required { version: FsVersion }).
editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>
//   undefined    → unconditionally replace literal text in the current content (bare default);
//                  a missing target still reports FS_STALE_VERSION
//   { version }  → edit only at that version, else FS_STALE_VERSION (the current behavior)
```

The `FsWriteIntent` union itself does not change — the third "unconditional" state is expressed by *omitting* `expected`, so both mutations share one symmetric shape (`expected?`: omit = no guard, present = guarded). This keeps full backward compatibility for the guarded paths `dsh-fs-policy` uses; only the previously-impossible "no guard" case is new, and it is the bare-provider default. The mutation still runs inside the backend's per-target lock either way, so an unconditional write/edit is still atomic (no torn files); "unconditional" drops the *version* precondition, not the atomicity. `editText` reports a missing target as `FS_STALE_VERSION` on both guarded and unguarded paths, preserving one edit failure code for "the target cannot be edited at this moment".

## Event vocabulary (owned by `dsh-fs`)

The events live in `@deepseek-ai/dsh-fs`, not in `dsh-fs-policy`. This is forced by the decoupling contract: `dsh-tool-fs` is the emitter, so it must reference the event types, and it must keep compiling even though `dsh-fs-policy` no longer provides a method service. `dsh-fs` is the package both `dsh-tool-fs` and `dsh-fs-policy` already depend on, so it is the only home that lets the emitter and the policy listener share a vocabulary without the emitter depending on the policy plugin.

These events carry existing `dsh-fs` vocabulary (`FsTarget`, `FsVersion`, `FsWriteIntent`) plus an opaque actor — not model-facing concepts (no line windows, numbered lines, or rendered footers leak down).

**The two `fs/*` decision events are single-slot decision points, NOT a composable interception chain.** A waterfall listener that does not call `next()` short-circuits the rest of the chain (verified in [vendor/cordis/src/events.ts](../../../../vendor/cordis/src/events.ts) — `waterfall` runs listeners around the final `next` thunk, and a listener that returns without calling `next()` reaches neither later listeners nor the tool's default thunk). `dsh-fs-policy` fully decides the write/edit expectation and does not call `next()`, so it occupies that one decision slot in the default deployment. This is deliberate: "what version basis does this mutation guard against" is a single decision, not an accumulation. The names (`fs/write-intent`, `fs/edit-intent`) say "produce the value", not "authorize", so they do not imply a stackable authorization chain. Genuinely composable interception (permission, audit, sandbox) belongs on the existing `tools/execute` waterfall, which every tool call already flows through — not on this fs version-decision slot.

**The occupant is decided by registration order — first-registered (or `prepend`ed) wins.** cordis dispatches waterfall listeners in registration order (`push`, or `unshift` for `prepend` — [vendor/cordis/src/events.ts](../../../../vendor/cordis/src/events.ts)), and the first non-`next()` decider short-circuits the rest. So the slot is **first-wins**, and `dsh-fs-policy` owning it rests on the default deployment convention: it is the decider registered for these events. The event shape does NOT itself guarantee "an unread edit is rejected" — a plugin that registers a looser `fs/edit-intent` decider BEFORE `dsh-fs-policy` (or with `prepend`) would decide first and bypass the `FS_NOT_OBSERVED` gate. That is the inherent property of a first-wins single slot, stated here so it is not mistaken for an enforced invariant. This RFC does not add a multi-policy composition mechanism; the implementation requirement is that `dsh-tool-fs` dispatches these waterfalls on every write/edit path and that a config wiring the fs tools loads `dsh-fs-policy` as the policy decider.

The actor is typed `object` in `dsh-fs` — a pure opaque carrier the provider seam never reads or narrows. The owner-derivation (`actor.agent?.session`) and the `{ agent?: { session? } }` structural shape stay entirely inside `dsh-fs-policy`, which narrows the `object` actor to that shape in its listeners. `dsh-fs` owns the event names and the fs vocabulary; it does NOT own the policy layer's runtime owner structure.

```ts
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'

interface Events {
  /**
   * Single-slot decision: produce the write expectation for the next
   * ctx.fs.writeText. The default returns undefined (unconditional create-or-
   * overwrite — the bare provider). The policy listener returns createIfAbsent
   * (unobserved) or { kind: 'replaceIfVersion', version: vObserved } (observed).
   * The listener does NOT call next(): one decision, not a composable chain. @mode waterfall
   */
  'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
  /**
   * Single-slot decision: produce the optional version guard for the next
   * ctx.fs.editText. The default returns undefined (unconditional edit of the
   * current content — the bare provider; no stat). The policy listener returns
   * { version: vObserved }, or throws FS_NOT_OBSERVED if the actor is unset or
   * has not observed the target. Does NOT call next(): one decision. @mode waterfall
   */
  'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
  /**
   * Record that an actor observed a target at a version, after a successful
   * read/write/edit. Fire-and-forget (plain emit). Listeners MUST be
   * synchronous, side-effect-only recorders (`dsh-fs-policy`'s is a WeakMap
   * write); the tool does not guard the emit, so a throwing listener surfaces as
   * the tool's isError result. No listener ⇒ nothing recorded.
   * @mode emit
   */
  'fs/observed'(target: FsTarget, version: FsVersion, actor: object | undefined): void
}
```

The `fs/*` decision events are **unbound waterfalls dispatched by the tool** (like `agent/request`, which the loop dispatches with no `this`), not service-bound waterfalls (like `llm/stream`). The dispatcher is the `dsh-tool-fs` plugin, which is not a service.

## Tool contract (`dsh-tool-fs`)

The tool keeps its model-facing schemas (`read`/`write`/`edit`, byte-for-byte unchanged) and prompt sections. The prompt guidance stays policy-first because a deployment loading the fs tools is expected to also load `dsh-fs-policy`: the model is still told to read before overwriting or editing, and any wording that says the "backend" requires that should be corrected to say the fs-policy plugin requires it. The bare-provider fallback does not change the prompt stance.

`dsh-tool-fs` gains the executor responsibilities relocated from the old `fileContext` method service, including **read rendering** (`read-render.ts`: `buildWindow` + `formatReadOutput`, `READ_MAX_BYTES`, `READ_MAX_LINE_LENGTH`, `FileReadOutcome`/`FileTextLine`, plus `STREAM_MIN_SIZE` in `read.ts`), which is the tool's rendering detail now that the tool owns the read. Those read-rendering types and helpers move into `dsh-tool-fs`; the policy plugin must not remain a type dependency for the tool.

`dsh-tool-fs` is a single root plugin that registers all three tools (`read`/`write`/`edit`), mirroring `dsh-tool-bash`. It injects `fs` (plus `tools`/`systemPrompt`), never `fileContext`. (The original proposal also exposed each tool as a `/read`/`/write`/`/edit` subpath plugin for focused deployments; that was dropped on implementation — no consumer needed a single-tool deployment, and the subpath publishing forced bespoke `tsdown`/`tsconfig`/`files`/workspace-constraint handling no sibling tool package carries. The per-tool registration helpers (`applyReadTool`/`applyWriteTool`/`applyEditTool`) remain internal modules the root plugin composes.)

`stat` budget is minimized by letting the waterfall produce the expectation lazily — the bare default returns `undefined` (no guard) and never stats:

- **read** — one `stat` (type + size routing + version), then `readText`/`streamText`, then `buildWindow`, then an `emit('fs/observed', target, info.version, exec)`. The post-read confirming `stat` from the old `fileContext.read` is dropped; a writer racing between the routing stat and the read can at worst make a *later* guarded edit spuriously `FS_STALE_VERSION` (fail-closed: the model re-reads, never writes against the wrong version, since `editText` re-checks in its lock).
- **write** — `expectation = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)`, then `ctx.fs.writeText(target, content, expectation)`, then an `emit('fs/observed', target, outcome.version, exec)`. **Zero stat in the tool** with or without `dsh-fs-policy`.
- **edit** — `expectation = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)`, then `ctx.fs.editText(target, edit, expectation)`, then an `emit('fs/observed', target, outcome.version, exec)`. **Zero stat in the tool** in both cases: the bare default is `undefined` (unconditional edit), so the tool never stats to manufacture a basis. If the target is absent, the provider reports `FS_STALE_VERSION` even on the unguarded path.

The tool passes `exec` (the tool-execution context) as the `actor` argument on every dispatch, so `dsh-fs-policy` can derive its observed-state owner. The tool does not know whether the policy plugin is present: it always provides the bare default behavior in the `next` thunk, and `dsh-fs-policy` short-circuits the thunk before it runs in the default deployment.

**`fs/observed` fires AFTER the mutation already succeeded**, via a plain `ctx.emit`. The event contract is intentionally narrow: an `fs/observed` listener MUST be synchronous and side-effect-only — `dsh-fs-policy`'s listener is a `WeakMap.set`, which cannot throw under normal operation and returns no promise. The tool does not guard the emit, so a listener that violates the contract by throwing would surface as the tool's `isError` result ([tools/index.ts](../../../../packages/core/tools/src/index.ts) — `ToolRegistry.execute` catches a tool throw into an error result) — reporting failure for a write/edit that actually happened. That is the price of keeping the event a plain fire-and-forget recorder: cordis `emit` does not await listener promises, so async or fallible audit/telemetry/listener work does not belong on this event. If layered or async observation is ever wanted, that is a new event with its own dispatch story.

## Policy plugin contract (`dsh-fs-policy`)

`dsh-fs-policy` is a plugin, not a service. It does not register `ctx.fileContext`, has no public method surface, and exposes no `read`/`write`/`edit`/`resolve` methods. It attaches three listeners via `ctx.on()` registrations (each returning a disposer for HMR). It keeps the observed-state `WeakMap<owner, Map<targetKey, { version }>>` and the structural owner derivation (narrowing the event's opaque `object` actor to its own `{ agent?: { session? } }` shape), but does not inject `fs` — every handler operates only on its own `WeakMap`, never on `ctx.fs`.

- `fs/write-intent` listener: `prior = getObserved(owner, key)`; return `prior ? { kind: 'replaceIfVersion', version: prior.version } : { kind: 'createIfAbsent' }`. It does NOT call `next()`: it fully owns the single decision slot.
- `fs/edit-intent` listener: `prior = getObserved(owner, key)`; if no `owner` or no `prior`, throw `FS_NOT_OBSERVED`; else return `{ version: prior.version }`. Also does not call `next()`.
- `fs/observed` listener: `record(owner, key, version)`.

An observed-state entry is the **prior-observation record**: a successful `read`, `write`, OR `edit` all emit `fs/observed` and record `{ version }`, so the entry's presence means "this owner has observed this target at this version", not narrowly "has read it". This is what lets a create-then-edit or edit-then-edit sequence work without an intervening re-read: the mutation refreshes the recorded version to its own result, so the next edit's basis is the version it just produced. `FS_NOT_OBSERVED` rejects only an edit with NO prior observation of any kind. The owner is derived structurally from `{ agent?: { session? } }`; disposal drops all state (HMR safety).

`dsh-fs-policy` is now a pure policy/recording plugin with no service surface — it influences the world only through the event seam. That is what removes the method coupling from `dsh-tool-fs`.

## Bare-provider behavior (no `dsh-fs-policy`)

This is not the intended deployment stance — a config loading the fs tools is expected to also load `dsh-fs-policy`. It is the unconstrained provider floor that exists once the tool is no longer coupled to a policy method service. With `dsh-fs-policy` absent, every `fs/*` waterfall falls through to its `undefined` default and `fs/observed` has no listener:

- **read** is identical (it never needed policy; it only emits a now-unheard `fs/observed`).
- **write** unconditionally creates-or-overwrites: `expected` is `undefined`, so `writeText` writes whether or not the file exists and whatever its current version. No read-first requirement, no version check.
- **edit** unconditionally replaces literal text in the file's current content: `expected` is `undefined`, so `editText` matches and rewrites without a version guard or a read-first requirement (`FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT` still apply — those are about the literal match, not freshness). A missing target still reports `FS_STALE_VERSION`, matching the guarded edit path's "cannot edit this target now" code.

Both mutations are still atomic (the backend's per-target lock is unconditional). What is simply *absent*, not lost, is the policy `dsh-fs-policy` would add: observed-state, read-before-edit, and version-guarded write/edit. Loading `dsh-fs-policy` layers those constraints on by having its listeners return guarded `expected` values instead of `undefined`; nothing in the bare provider changes.

## Supersedes

This amends — does not reverse — [the split-fs-seam RFC](../simplification/2026-06-26-fsspec-style-fs-seam.md). The four-layer split, the provider contract, and the freshness *policy* are all kept. What changes is the **coupling between the tool and the policy layer**: a mandatory method service became a plugin-owned event gate, and the fs I/O + read windowing moved from `fileContext` up into `dsh-tool-fs`. The split-fs-seam RFC's description of `dsh-tool-fs` injecting `fileContext` and of `fileContext` owning `read`/`write`/`edit` was updated to match in the same change.

## Acceptance Criteria

- The `dsh-tool-fs` root plugin injects `fs` (+ `tools`/`systemPrompt`), not `fileContext`; it calls `ctx.fs` directly and dispatches the `fs/write-intent`/`fs/edit-intent` waterfalls (passing `exec` as the actor) and the `fs/observed` emit. Read rendering lives in `dsh-tool-fs`. (No subpath plugins — see the Tool contract above.)
- `dsh-fs` declares the three events with `@mode` tags and an opaque `object` actor argument (no agent/session structure leaks into the provider vocabulary); the generated cordis catalog is regenerated.
- `dsh-fs-policy` is a plugin, not a service: it does not register `ctx.fileContext`, has no public `read`/`write`/`edit`/`resolve` methods, and does not inject `fs`; it registers the three listeners, keeps observed-state, and has HMR/disposal coverage (dispose the fiber, assert the gate no longer rewrites).
- **Bare-provider test**: a config WITHOUT `dsh-fs-policy` boots the `dsh-tool-fs` root plugin, and `read`/`write`(create AND overwrite)/`edit` work against the real `dsh-fs-local`; an `edit` of an unread existing file and an overwrite of an existing unread file both succeed (unconditional bare-provider behavior), proving the tool carries no `fileContext` dependency. A bare-provider edit of a missing target reports `FS_STALE_VERSION`. With `dsh-fs-policy` present, the same unread `edit` is rejected `FS_NOT_OBSERVED` and the same unread overwrite uses `createIfAbsent` (rejected on an existing file).
- **Single-slot semantics**: a test registers a second `fs/edit-intent` listener AFTER `dsh-fs-policy` and asserts it is NOT reached (first-wins short-circuit), and documents in a comment that a decider registered before/`prepend`ed would instead win — the slot is first-wins by convention, not an enforced invariant.
- **Fire-and-forget recording**: `fs/observed` is emitted via a plain `ctx.emit` after the mutation succeeds; a listener is contractually synchronous and side-effect-only, so the tool does not guard it.
- `dsh-fs` `writeText`/`editText` make `expected` optional (omit ⇒ unconditional); the `FsWriteIntent` union is unchanged, and `dsh-fs-policy`'s guarded paths (`createIfAbsent`/`replaceIfVersion`/`{ version }`) behave exactly as today. A bare-provider test exercises an unconditional overwrite, an unconditional edit, and a missing-target edit reporting `FS_STALE_VERSION`.
- Freshness is enforced by provider CAS when guarded: an edit after a stale read reports `FS_STALE_VERSION` (regression test); `dsh-fs-policy` performs no `stat`.
- `stat` budget: read = 1, write = 0, edit = 0 — in the tool, with or without `dsh-fs-policy` (the bare default returns `undefined`, never stats). A test asserts neither write nor edit stats in the tool on either path.
- Model-facing schemas stay byte-for-byte unchanged; snapshot transcript goldens are unaffected (or the diff is reviewed and re-recorded with justification).
- Docs/artifacts updated in the same change: `docs/architecture.md`, fs package READMEs, `docs/core-data-structures/filesystem.md`, the split-fs-seam RFC's now-amended description, type-equiv blocks + manifest, cordis catalog, module graph. Gates green: `doc-sync`, `knip`, `test:coverage` (100% per-file).

## Risks

- **Event indirection over a method call.** A waterfall + emit is less direct than `await ctx.fileContext.edit(...)`. The payoff is removing the tool-to-policy method dependency while keeping the default policy plugin; the cost is one more event vocabulary to learn. Mitigated by keeping the three events narrow and documenting the default-thunk semantics on each.
- **Policy events in the storage seam.** `dsh-fs` gains two version-decision events plus a recording event though it is "just storage". This is the price of decoupling (the emitter cannot depend on the policy plugin). The events carry only `dsh-fs` vocabulary plus an opaque `object` actor and no model-facing concepts, so the seam stays free of line-window/observation policy types and of the agent/session owner structure.
- **Single policy occupant, first-wins by convention.** The `fs/write-intent`/`fs/edit-intent` slots hold exactly one decider; the first-registered (or `prepend`ed) listener wins and the rest are short-circuited. `dsh-fs-policy` owning the slot is a deployment convention, not an event-enforced invariant — a second decider registered first would bypass it. This is acceptable because a second fs-version-policy decider is a misconfiguration, not a feature. If a future need for *layered* fs version policy appears, it is a new RFC (a composable value-passing seam), not a silent second listener on these events. Layered permission/audit/sandbox interception already has its home on `tools/execute`.
- **Dropping the post-read confirming stat** makes a follow-up *guarded* edit occasionally fail-closed (`FS_STALE_VERSION` → re-read) under a read/write race. This is a UX nicety lost, never a correctness hole; the provider lock still prevents wrong-version writes.
- **The bare provider does no read-before-write/edit and no version check.** A deployment without `dsh-fs-policy` lets the model overwrite or edit any existing file unconditionally. This is the deliberate meaning of keeping the tool independent of a policy service: the safety disciplines live in the `dsh-fs-policy` plugin. A deployment that omits it is opting into an unconstrained filesystem on purpose; that is not the intended stance for a config that ships the fs tools.
