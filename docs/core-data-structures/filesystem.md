# Filesystem

The filesystem execution seam is split across three packages: interface ([dsh-fs](../../packages/fs/fs), `ctx.fs`), implementation ([dsh-fs-local](../../packages/fs/fs-local), local disk), and consumer ([dsh-tool-fs](../../packages/fs/tool-fs), the model-facing `read`/`write`/`edit` tools). Filesystem access is an optional capability, not part of the agent-loop spine, so its vocabulary lives here rather than in [core.md](core.md). A sandboxed, remote, virtual, or project-scoped backend can implement the same `FileSystem` service without changing the tool schemas.

Source: [`packages/fs/fs/src/types.ts`](../../packages/fs/fs/src/types.ts) and [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)

## Execution context and target identity

The filesystem seam needs just enough execution context to derive the observed-file owner. `ToolExecution` satisfies this shape, so `dsh-tool-fs` passes its execution object through without making `dsh-fs` import the tool, agent, or session packages.

```ts type-equiv
interface FsExecContext {
  agent?: {
    session?: object
  }
}
```

Every operation resolves a user-supplied path to an opaque backend target first. Consumers may display `displayPath`, but must not parse `targetKey` or assume it is a local absolute path.

```ts type-equiv
interface FsTarget {
  inputPath: string
  targetKey: string
  displayPath: string
}
```

The backend also owns file-version tokens. `ctx.fs` stores them for stale checks; consumers do not interpret them.

```ts type-equiv
type FsVersion = string
```

## Reads and editable views

A text read is bounded by line window, byte cap, and backend limits. The returned view records whether the owner saw the whole file or only a partial page; only a `full` view authorizes later write/edit.

```ts type-equiv
interface FsReadRequest {
  offset: number
  limit: number
}
```

```ts type-equiv
interface FsTextLine {
  number: number
  text: string
}
```

```ts type-equiv
type FsView = 'full' | 'partial'
```

```ts type-equiv
interface FsReadOutcome {
  offset: number
  limit: number
  lines: FsTextLine[]
  totalLines: number
  truncatedByBytes?: true
  version: FsVersion
  view: FsView
}
```

## Write and edit guards

The base `FileSystem` service converts recorded state into an `FsExpectation` before calling the backend. `observed` carries the stale guard, `partial` means the owner saw a non-editable view, and `unobserved` allows create-if-absent but rejects blind overwrite.

```ts type-equiv
type FsExpectation =
  | { kind: 'observed'; version: FsVersion }
  | { kind: 'partial'; version: FsVersion }
  | { kind: 'unobserved' }
```

```ts type-equiv
interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
}
```

Literal edit is a backend operation, not a `read` plus `write` composed in the tool wrapper. That keeps matching, line-ending handling, stale checks, and atomic replacement inside the filesystem seam.

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

## Observed-file state

Observed state is keyed inside the service by owner object and `FsTarget.targetKey`. The owner is normally `exec.agent.session`, but `dsh-fs` treats it as opaque and never reads its fields. A successful read/write/edit refreshes this state for that owner.

```ts type-equiv
type FsStateSource = 'read' | 'write' | 'edit'
```

```ts type-equiv
interface FileState {
  targetKey: string
  displayPath: string
  version: FsVersion
  view: FsView
  updatedAt: number
  source: FsStateSource
}
```

## Error taxonomy

Filesystem failures use stable `FsErrorCode` strings carried by `FsError` (`HarnessError`). The tool registry preserves `{ name, code }` on error results, so retry, permission, and UI layers can branch without parsing text.

```ts type-equiv
type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_PARTIAL_OBSERVATION'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'
```

`FS_NOT_OBSERVED` means no usable prior observation exists. `FS_PARTIAL_OBSERVATION` means the owner saw only a partial read. `FS_STALE_VERSION` means there was a prior full observation, but the backend version no longer matches.

## The service

`FileSystem` (`ctx.fs`, abstract) owns the shared orchestration: `resolve`, `readPage`, `createOrReplace`, and `applyEdit` are backend primitives; public `read`, `write`, and `edit` derive/record owner state and enforce the read-before-write/edit policy before delegating to the backend. The generated wiring catalog shows the exact service signatures on [events-and-services.md](../cordis-catalog/events-and-services.md#ctxfs--filesystem-abstract-seam).
