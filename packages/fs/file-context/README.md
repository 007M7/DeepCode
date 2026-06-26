# @deepseek-ai/dsh-file-context

The **file-context policy layer**: a concrete `ctx.fileContext` service that owns model-facing read windowing and write/edit freshness on top of the `ctx.fs` provider seam ([`@deepseek-ai/dsh-fs`](../fs)). This is the policy third of the filesystem stack — it is **not** a swappable seam, but the deferred policy layer that does not belong on the `FileSystem` provider base class.

```ts
import type { Context } from 'cordis'
import FileContext from '@deepseek-ai/dsh-file-context'

declare const ctx: Context

// A ctx.fs provider must already be loaded (e.g. @deepseek-ai/dsh-fs-local);
// FileContext injects `fs` and registers ctx.fileContext. Load
// @deepseek-ai/dsh-tool-fs afterwards to expose read/write/edit to the model.
await ctx.plugin(FileContext)
```

## The four-layer split

| Layer | Package | Role |
|---|---|---|
| tool | `@deepseek-ai/dsh-tool-fs` | model-facing schemas + text rendering |
| policy | `@deepseek-ai/dsh-file-context` (this) | `ctx.fileContext`: observed-state, read windowing, write/edit freshness |
| provider seam | `@deepseek-ai/dsh-fs` | `ctx.fs`: text IO + guarded mutation primitives |
| provider | `@deepseek-ai/dsh-fs-local` | local implementation of `ctx.fs` |

## Service API (`ctx.fileContext`)

| Member | Semantics |
|---|---|
| `read(target, request, exec?, signal?)` | Stats the target, rejects absent/non-regular targets, chooses `readText`/`streamText` by size, builds the requested line window, records the version, and returns the `FileReadOutcome` the tool renders. |
| `write(target, content, exec?, signal?)` | No recorded read → `writeText({ kind: 'createIfAbsent' })` (only new files create blindly); a recorded read → `writeText({ kind: 'replaceIfVersion', version })`. Refreshes recorded state on success. |
| `edit(target, edit, exec?, signal?)` | Requires a recorded read by this owner (else `FS_NOT_OBSERVED`); passes the observed version to `ctx.fs.editText` as the stale guard and refreshes recorded state. |
| `owner(exec?)` | Derives the observed-state owner (`exec.agent.session`) — `undefined` when there is none. |

## Observed state is the read record, freshness is the authorization

Observed state is a `WeakMap<owner, Map<targetKey, { version }>>`. An entry exists **iff** the owner has read that target through `read`, so its presence *is* the read record — there is no `hasRead` flag and no `full`/`partial` view. Authorization is based on version freshness only: a windowed read of lines 100-150 records the file's version, and a later edit of line 120 is authorized as long as the file is unchanged (the provider's stale guard enforces it). State is held weakly and dropped on disposal (HMR safety); persistence across sessions is deferred.

## The no-bypass contract

A model-facing read MUST go through `ctx.fileContext.read`, never `ctx.fs.readText`/`streamText`, so every successful read records observed state before the tool renders. Direct `ctx.fs` calls remain an explicit escape hatch for non-tool consumers: a direct `ctx.fs.readText` records nothing, so a later `ctx.fileContext.edit` rejects with `FS_NOT_OBSERVED` until the file is read through `ctx.fileContext`.

The line-windowing mechanics live in `src/window.ts` (Cordis-free, independently unit-tested); `src/index.ts` is the service wiring and policy.
