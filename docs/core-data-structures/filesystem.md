# Filesystem

The filesystem stack is split across four packages: a provider seam ([dsh-fs](../../packages/fs/fs), `ctx.fs`, text IO + guarded mutation), a local implementation ([dsh-fs-local](../../packages/fs/fs-local), local disk), a policy layer ([dsh-file-context](../../packages/fs/file-context), `ctx.fileContext`, read windowing + write/edit freshness), and a consumer ([dsh-tool-fs](../../packages/fs/tool-fs), the model-facing `read`/`write`/`edit` tools). Filesystem access is an optional capability, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). A sandboxed, remote, virtual, or project-scoped backend can implement the same `FileSystem` service without changing the policy layer or the tool schemas.

Provider source: [`packages/fs/fs/src/types.ts`](../../packages/fs/fs/src/types.ts) and [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts). Policy source: [`packages/fs/file-context/src/types.ts`](../../packages/fs/file-context/src/types.ts).

## Target identity and metadata (provider seam)

Every operation resolves a user-supplied path to an opaque backend target first. Consumers may display `displayPath`, but must not parse `targetKey` (a branded opaque id) or assume it is a local absolute path.

```ts type-equiv
interface FsTarget {
  inputPath: string
  targetKey: FsTargetKey
  displayPath: string
}
```

The backend owns file-version tokens — the freshness token a write/edit guards against. The policy layer stores them for stale checks; consumers do not interpret them. Both ids are branded opaque strings.

```ts type-equiv
type FsTargetKey = Branded<'FsTargetKey'>
```

```ts type-equiv
type FsVersion = Branded<'FsVersion'>
```

`stat` returns metadata (never content), or `undefined` when the target is absent. `type` lets the policy layer reject directories/special files before reading, and `size` lets it choose `readText` vs `streamText` without probing by failure.

```ts type-equiv
interface FsInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}
```

## Write and edit guards (provider seam)

`writeText` takes an explicit write expectation rather than inferring intent. `createIfAbsent` creates a missing target and rejects an existing one with `FS_NOT_OBSERVED`; `replaceIfVersion` replaces only when the target exists at the observed version, else `FS_STALE_VERSION`.

```ts type-equiv
type FsWriteExpectation =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }
```

```ts type-equiv
interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
}
```

`editText` is a provider-level guarded mutation, not a `read` plus `write` composed in the policy layer. It verifies the expected version BEFORE literal matching (so a stale edit reports `FS_STALE_VERSION`, not a match failure against newer content), then applies the replacement and writes atomically — keeping matching, line-ending handling, stale checks, and atomic replacement inside one mutation critical section.

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

## Execution context and read outcome (policy layer)

The policy layer needs just enough execution context to derive the observed-state owner. `ToolExecution` satisfies this shape, so `dsh-tool-fs` passes its execution object through without making `dsh-file-context` import the tool, agent, or session packages.

```ts type-equiv
interface FileContextExec {
  agent?: {
    session?: object
  }
}
```

A text read is bounded by line window, byte cap, and backend limits. The outcome the model-facing `read` tool renders carries the file's version at read time; there is no `full`/`partial` view — authorization is freshness-based, so any windowed read can authorize a later write/edit when the file is unchanged.

```ts type-equiv
interface FileReadRequest {
  offset: number
  limit: number
}
```

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

## Observed-file state (policy layer)

Observed state is a `WeakMap<owner, Map<targetKey, { version }>>` inside `ctx.fileContext`. An entry exists **iff** the owner has read that target through `ctx.fileContext.read`, so its presence *is* the read record — there is no separate `hasRead` flag and no view distinction. The owner is normally `exec.agent.session`, but the policy layer treats it as opaque and never reads its fields. A successful read/write/edit refreshes the recorded version for that owner; disposal drops everything (HMR safety).

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

`FS_NOT_OBSERVED` means no recorded read exists for this owner (or a `createIfAbsent` hit an existing file). `FS_STALE_VERSION` means the backend version no longer matches the observed one. Freshness authorization has no partial/full distinction, so there is no `FS_PARTIAL_OBSERVATION`.

## The services

`FileSystem` (`ctx.fs`, abstract) owns the provider primitives: `resolve`, `stat`, `readText`, `streamText`, `writeText`, and `editText`. `FileContext` (`ctx.fileContext`, concrete) injects `fs` and owns the model-facing policy: `read` windows text and records observed state, `write`/`edit` derive the freshness expectation and refresh state. The generated wiring catalog shows the exact service signatures on [events-and-services.md](../cordis-catalog/events-and-services.md#ctxfs--filesystem-abstract-seam).
