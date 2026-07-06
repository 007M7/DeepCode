# @deepseek-ai/dsh-fs-policy

The **fs-policy plugin**: it adds observed-state, read-before-edit, and version-guarded write/edit on top of the `ctx.fs` provider seam ([`@deepseek-ai/dsh-fs`](../fs)) — through the `fs/*` event gate, **NOT** through a method service. This plugin registers **no** `ctx.fsPolicy` service and has no public `read`/`write`/`edit`/`resolve` methods. It is the policy third of the filesystem stack: not a swappable seam, but the policy that does not belong on the `FileSystem` provider base class.

```ts
import type { Context } from 'cordis'
import * as FsPolicy from '@deepseek-ai/dsh-fs-policy'

declare const ctx: Context

// No service to inject — this plugin only registers the three fs/* listeners.
// Load it alongside a ctx.fs provider (e.g. @deepseek-ai/dsh-fs-local) and the
// @deepseek-ai/dsh-tool-fs tools; the tools dispatch the fs/* events this plugin
// decides. Order does not matter for resolution (no inject), but the policy
// listener should be the first decider registered for the fs/*-intent slots.
await ctx.plugin(FsPolicy)
```

## The four-layer split

| Layer | Package | Role |
|---|---|---|
| tool / executor | `@deepseek-ai/dsh-tool-fs` | model-facing schemas + read windowing + text rendering; reads/writes/edits via `ctx.fs`, dispatches the `fs/*` events |
| policy | `@deepseek-ai/dsh-fs-policy` (this) | observed-state + read-before-edit + version-guarded write/edit, contributed through the `fs/*` event gate (no service) |
| provider seam | `@deepseek-ai/dsh-fs` | `ctx.fs`: text IO + atomic mutation primitives (optional version guard); owns the `fs/*` event vocabulary |
| provider | `@deepseek-ai/dsh-fs-local` | local implementation of `ctx.fs` |

## How the gate participates

Three `fs/*` events (declared by `@deepseek-ai/dsh-fs`, dispatched by `@deepseek-ai/dsh-tool-fs`):

| Event | This plugin's listener |
|---|---|
| `fs/write-intent` | No prior observation → `{ kind: 'createIfAbsent' }`; a prior observation → `{ kind: 'replaceIfVersion', version: vObserved }`. Single-slot decision; does NOT call `next()`. |
| `fs/edit-intent` | Requires a prior observation by this owner (else throws `FS_NOT_OBSERVED`); returns `{ version: vObserved }` as the CAS basis. Single-slot decision; does NOT call `next()`. |
| `fs/observed` | Records `{ version }` for this owner+target. Synchronous, side-effect-only `WeakMap.set`. |

## Observed state is the prior-observation record; freshness is provider CAS

Observed state is a `WeakMap<owner, Map<targetKey, FsVersion>>`. An entry exists **iff** the owner has read, written, OR edited that target (every success emits `fs/observed`), so its presence is the prior-observation record — there is no `hasRead` flag and no `full`/`partial` view. This plugin does **no** filesystem I/O: "have you observed this file?" is a `WeakMap` lookup, and "is the version you read still current?" is decided inside `ctx.fs.editText`/`writeText` in the same atomic lock that performs the mutation — this plugin only supplies `vObserved` as the basis. A windowed read of lines 100-150 records the file's version, and a later edit of line 120 is authorized as long as the file is unchanged. State is held weakly and dropped on disposal (HMR safety); persistence across sessions is deferred.

## Single-slot, first-wins

The `fs/write-intent`/`fs/edit-intent` slots hold exactly one decider — this plugin fully decides and does not call `next()`. The slot is first-wins by registration order; this plugin owning it is the default-deployment convention, not an event-enforced invariant (a decider registered before / `prepend`ed would win instead). This is not a composable authorization chain — layered permission/audit/sandbox interception belongs on `tools/execute`.

## No method coupling

Because the plugin influences the world only through events, removing it does not break `@deepseek-ai/dsh-tool-fs` at a service-injection boundary: the tool falls through to the bare `ctx.fs` provider (unconditional write/edit, no observed-state). Loading it back layers the policy on. That graceful add/remove is the whole point of the event gate over a mandatory method service.
