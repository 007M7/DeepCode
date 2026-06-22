# @deepseek-ai/dsh-fs

The **filesystem seam**: an abstract `FileSystem` service (`ctx.fs`) defining WHAT a filesystem backend does — resolve paths, read bounded text pages, create/replace files, apply literal edits — without saying HOW.

This package is one third of the filesystem capability, split so each concern can evolve (and be swapped) independently (see [the capability-seam RFC](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md) and [the filesystem capability-seam RFC](../../../docs/rfc/implemented/architecture/2026-06-17-filesystem-capability-seam.md)):

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-fs` (this) | the interface: abstract service + vocabulary types + read-before-write/edit policy |
| `@deepseek-ai/dsh-fs-local` | an implementation: the host filesystem |
| `@deepseek-ai/dsh-tool-fs` | the model-facing `read`/`write`/`edit` tool schemas over `ctx.fs` |

A future sandboxed, virtual, or remote backend implements this interface and the tool schemas don't change.

## Service API (`ctx.fs`)

Consumers call the concrete public API; backends implement the four primitives.

| Member | Kind | Semantics |
|---|---|---|
| `resolve(path)` | primitive | Resolve a path into a stable `FsTarget` (`inputPath`, opaque `targetKey`, `displayPath`). Async — a remote backend may need I/O. The same file via different paths must yield the same `targetKey`. |
| `readPage(target, request, signal?)` | primitive | Read a bounded UTF-8 text page. Returns line-numbered content, `totalLines`, an opaque `version`, and a `view` (`full` only when the page covered the whole file). |
| `createOrReplace(target, content, expected, signal?)` | primitive | Create/replace a file honoring the `FsExpectation` stale guard. |
| `applyEdit(target, edit, expected, signal?)` | primitive | Atomic literal read-modify-write, verifying the expected version. `oldString` must be non-empty. |
| `read(target, request, exec?, signal?)` | public | Calls `readPage`, then records observed state for the derived owner. |
| `write(target, content, exec?, signal?)` | public | Builds the `FsExpectation` from recorded state, calls `createOrReplace`, refreshes state to `full`. Updating an existing file needs a prior `full` read; a create does not. |
| `edit(target, edit, exec?, signal?)` | public | Requires a prior `full` read by this owner (else `FS_NOT_OBSERVED` / `FS_PARTIAL_OBSERVATION`), rejects empty `oldString`, calls `applyEdit`, refreshes state. |
| `owner(exec?)` | helper | Derives the file-state owner (`exec.agent.session`) — `undefined` when there is none. |

## Read-before-write/edit lives in the seam

Write/edit safety depends on backend-defined target identity and version tokens, so `ctx.fs` — not the tool layer — records what each owner has observed (keyed by an opaque owner object, normally the agent session, then by `targetKey`) and enforces the policy. The base class owns owner derivation, the file-state store, and *which* `FsExpectation` to hand the backend; the backend owns version comparison and I/O. Only a `full` view authorizes write/edit; a `partial` view (paged/truncated read) records context but does not.

State is held in a `WeakMap` keyed by the owner object and dropped on disposal (HMR safety). Persistence across sessions is deferred — a resumed session must read files again before write/edit.

## Vocabulary

`FsTarget` / `FsVersion` are opaque — consumers must not parse `targetKey` or interpret `version`; only `displayPath` is for model/UI output. Failures throw `FsError` (extends `HarnessError`, [the structured error taxonomy RFC](../../../docs/rfc/implemented/architecture/2026-06-11-structured-error-taxonomy.md)) carrying a stable `FsErrorCode` (`FS_NOT_FOUND`, `FS_NOT_TEXT`, `FS_NOT_REGULAR_FILE`, `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_PARTIAL_OBSERVATION`, `FS_AMBIGUOUS_EDIT`, `FS_EDIT_NOT_FOUND`, `FS_ABORTED`); the tool registry surfaces `{ name, code }` on `isError` results. See `src/types.ts` for the full contracts.
