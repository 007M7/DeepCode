# Filesystem

The filesystem stack is split across four packages: a provider seam ([dsh-fs](../../packages/fs/fs), `ctx.fs`, text IO + atomic mutation primitives whose version guard is optional), a local implementation ([dsh-fs-local](../../packages/fs/fs-local), local disk), a policy plugin ([dsh-fs-policy](../../packages/fs/fs-policy), observed-state + read-before-edit + version-guarded write/edit, contributed through the `fs/*` event gate — NO service), and a consumer ([dsh-tool-fs](../../packages/fs/tool-fs), the model-facing `read`/`write`/`edit` tools, which is also the EXECUTOR — it reads/writes/edits through `ctx.fs` directly and owns read windowing). Filesystem access is an optional capability, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). A sandboxed, remote, virtual, or project-scoped backend can implement the same `FileSystem` service without changing the policy plugin or the tool schemas.

The model is **additive, not subtractive**: `ctx.fs` alone is a complete, unconstrained text-storage seam (`write` unconditionally creates-or-overwrites, `edit` unconditionally replaces literal text). `dsh-fs-policy` is a plugin that *adds* policy on top by deciding the `fs/*` waterfalls; removing it leaves the bare provider rather than breaking the tool, because the tool is not method-coupled to the policy. A deployment that loads `dsh-tool-fs` is expected to also load `dsh-fs-policy` so the default behavior is read-before-write/edit.

Provider source: [`packages/fs/fs/src/types.ts`](../../packages/fs/fs/src/types.ts) and [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts). Policy source: [`packages/fs/fs-policy/src/types.ts`](../../packages/fs/fs-policy/src/types.ts). Read-rendering source: [`packages/fs/tool-fs/src/read-render.ts`](../../packages/fs/tool-fs/src/read-render.ts).

## Target identity and metadata (provider seam)

Every operation resolves a user-supplied path to an opaque backend target first. Consumers may display `displayPath`, but must not parse `targetKey` (a branded opaque id) or assume it is a local absolute path.

```ts type-equiv
interface FsTarget {
  inputPath: string
  targetKey: FsTargetKey
  displayPath: string
}
```

The backend owns file-version tokens — the freshness token a write/edit guards against. The policy plugin stores them for stale checks; consumers do not interpret them. Both ids are branded opaque strings.

```ts type-equiv
type FsTargetKey = Branded<'FsTargetKey'>
```

```ts type-equiv
type FsVersion = Branded<'FsVersion'>
```

`stat` returns metadata (never content), or `undefined` when the target is absent. `type` lets the tool reject directories/special files before reading, and `size` lets it choose `readText` vs `streamText` without probing by failure.

```ts type-equiv
interface FsInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}
```

## Write and edit guards (provider seam)

Both `writeText` and `editText` take their version guard OPTIONALLY: omit it for an unconditional (bare-provider) mutation, supply it to guard. `writeText`'s guard is an `FsWriteIntent` — `createIfAbsent` creates a missing target and rejects an existing one with `FS_NOT_OBSERVED`; `replaceIfVersion` replaces only when the target exists at the observed version, else `FS_STALE_VERSION`. Omitting `expected` unconditionally creates-or-overwrites. The union itself carries only the two guarded intents; "no guard" is expressed by omission, so write and edit share one symmetric `expected?` shape.

```ts type-equiv
type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }
```

```ts type-equiv
interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
}
```

`editText` is a provider-level mutation, not a `read` plus `write` composed elsewhere. When guarded it verifies the expected version BEFORE literal matching (so a stale edit reports `FS_STALE_VERSION`, not a match failure against newer content); unguarded it edits the current content. Either way it applies the replacement and writes atomically — keeping matching, line-ending handling, the stale check, and atomic replacement inside one mutation critical section — and a missing target reports `FS_STALE_VERSION` on both paths.

```ts type-equiv
interface FsEditRequest {
  oldString: string
  newString: string
  replaceAll: boolean
}
```

```ts type-equiv
interface FsEditOutcome {
  replacements: number
  replaceAll: boolean
  version: FsVersion
}
```

## The fs policy events (provider-seam vocabulary)

`dsh-fs` owns three events the tool dispatches and the policy plugin listens for, so the emitter (`dsh-tool-fs`) and the listener (`dsh-fs-policy`) share a vocabulary without the emitter depending on the policy plugin. They carry only `dsh-fs` vocabulary plus an opaque `object` actor — no model-facing concepts and no agent/session owner structure.

`fs/write-intent` and `fs/edit-intent` are **single-slot decision waterfalls**: the tool dispatches each with a default thunk returning `undefined` (the bare provider), and a listener fully decides without calling `next()`. The slot is first-wins by registration order — the policy plugin owning it is a deployment convention, not an enforced invariant. `fs/observed` is a fire-and-forget recording event dispatched with a plain `ctx.emit`; its listener MUST be synchronous and side-effect-only, because the tool does NOT guard the emit — a throwing listener would surface as the tool's `isError` result for a mutation that already succeeded. The generated catalog shows the exact signatures on [events-and-services.md](../cordis-catalog/events-and-services.md).

## Execution context (policy plugin)

The policy plugin needs just enough execution context to derive the observed-state owner by narrowing the opaque `object` actor the `fs/*` events carry. `ToolExecution` satisfies this shape, so `dsh-tool-fs` passes its execution object through as the actor without making `dsh-fs-policy` import the tool, agent, or session packages.

```ts type-equiv
interface FsPolicyExec {
  agent?: {
    session?: object
  }
}
```

## Read outcome (consumer / read rendering)

A text read is bounded by line window, byte cap, and backend limits. The outcome the model-facing `read` tool renders carries the file's version at read time; there is no `full`/`partial` view — authorization is freshness-based, so any windowed read can authorize a later write/edit when the file is unchanged. Read windowing and this outcome shape live in `dsh-tool-fs` (the executor that owns the read), not in the policy plugin.

```ts type-equiv
interface FileReadOutcome {
  offset: number
  limit: number
  lines: FileTextLine[]
  totalLines: number
  truncatedByBytes?: true
  version: FsVersion
}
```

## Observed-file state (policy plugin)

Observed state is a `WeakMap<owner, Map<targetKey, { version }>>` held inside the `dsh-fs-policy` plugin. An entry exists **iff** the owner has read, written, OR edited that target (every success emits `fs/observed`), so its presence is the prior-observation record — there is no separate `hasRead` flag and no view distinction. The owner is derived from the event actor (normally `exec.agent.session`), treated as opaque and never read. A successful read/write/edit refreshes the recorded version for that owner; disposal drops everything (HMR safety).

## Error taxonomy (provider seam)

Filesystem failures use stable `FsErrorCode` strings carried by `FsError` (`HarnessError`). The tool registry preserves `{ name, code }` on error results, so retry, permission, and UI layers can branch without parsing text.

```ts type-equiv
type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'
```

`FS_NOT_OBSERVED` means the policy plugin has no prior-observation record for this owner (or a `createIfAbsent` hit an existing file). `FS_STALE_VERSION` means the backend version no longer matches the observed one (or an edit hit a missing target). Freshness authorization has no partial/full distinction, so there is no `FS_PARTIAL_OBSERVATION`.

## The service and the plugin

`FileSystem` (`ctx.fs`, abstract) owns the provider primitives: `resolve`, `stat`, `readText`, `streamText`, `writeText`, and `editText`. `dsh-fs-policy` registers **no service** — it is a plugin that adds policy through the `fs/*` event gate: it decides the write/edit intent waterfalls (supplying `createIfAbsent`/`replaceIfVersion`/`{ version }` or throwing `FS_NOT_OBSERVED`) and records on `fs/observed`. The executor is `dsh-tool-fs`: it reads/writes/edits through `ctx.fs`, dispatches the waterfalls, and emits the recording event. The generated wiring catalog shows the exact `ctx.fs` signatures on [events-and-services.md](../cordis-catalog/events-and-services.md#ctxfs--filesystem-abstract-seam).
