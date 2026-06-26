# RFC: Split the filesystem seam — provider text mutations plus policy `ctx.fileContext`

Status: implemented

## Problem

The filesystem capability from [filesystem-capability-seam](../../implemented/architecture/2026-06-17-filesystem-capability-seam.md) currently makes one abstract `FileSystem` service own two different jobs:

1. **Provider operations** — resolving targets, stat/version metadata, text reads/streams, atomic writes, and guarded literal edits.
2. **Agent-facing policy** — line windows, literal edit semantics, and read-before-write/edit observed-state.

That makes every future backend reimplement model-facing read semantics and observation policy. `readPage` returns numbered lines and view metadata; the base service stores per-owner file state and distinguishes `full` from `partial` reads. Those are useful policies, but they are not filesystem-provider primitives. Literal text mutation is different: version guard, literal match, ambiguity detection, and atomic rewrite must stay together inside the provider mutation boundary, but the current `applyEdit` name and surrounding seam tie that provider operation to the old read-before-edit policy shape.

This also creates a real UX dead-end: a windowed read records `view: partial`, and partial views cannot authorize `edit`. A model that reads lines 100-150 of a large file therefore cannot edit line 120 unless it first gets a `full` read, which may be impossible for a file past the read cap. Literal edit only needs freshness: the bytes being matched must still be from the version the model read.

The old RFC already deferred a separate `@deepseek-ai/dsh-file-context` package. This RFC builds that layer and keeps `ctx.fs` close to fsspec-style storage primitives (`info`/`cat`/`open`), without turning it into full fsspec.

## Decision

Split the stack into four layers:

```text
tool          dsh-tool-fs       model-facing schemas + text rendering
policy        dsh-file-context  ctx.fileContext (concrete service): observed-state, read windowing, write/edit freshness
provider seam dsh-fs            ctx.fs: text IO + guarded mutation primitives
provider      dsh-fs-local      local implementation of ctx.fs
```

`dsh-tool-fs` keeps the same model-facing `read`/`write`/`edit` schemas. It injects `fileContext`, not `fs`, and never reaches around the policy layer for model reads/writes/edits.

## Provider Contract

`@deepseek-ai/dsh-fs` shrinks to provider text IO plus guarded text mutation:

```ts ignore-check
abstract resolve(path: string): Promise<FsTarget>
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract writeText(target: FsTarget, content: string, expected: FsWriteExpectation, signal?: AbortSignal): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>

interface FsInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}

type FsWriteExpectation =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }
```

`stat` returns metadata, not content. `version` is the freshness token; `type` lets the policy reject directories/special files before reading; `size` lets `ctx.fileContext.read` choose `readText` vs `streamText` without probing by failure. `undefined` means absent.

`readText` reads the whole regular text file. `streamText` streams the same text semantics for large files. Both provider primitives own regular-file checks, UTF-8 decoding, binary/NUL rejection, and `FS_NOT_TEXT`; the policy layer never handles raw bytes or reimplements cross-chunk decoding. `readText` is the small-file/direct whole-file primitive, while large model-facing reads use `streamText`.

`writeText` is atomic temp-file + rename with an explicit write expectation. `createIfAbsent` creates a missing target and rejects an existing target with `FS_NOT_OBSERVED`; it is the path used when the owner has no prior read. `replaceIfVersion` replaces only when the target exists at the observed version; a missing target or version mismatch throws `FS_STALE_VERSION`.

`editText` is a provider-level guarded text mutation. It first verifies the target still exists at `expected.version`, then reads the current text, applies literal replacement, and writes atomically. The stale check must happen before literal matching so an edit based on an old read reports `FS_STALE_VERSION`, not `FS_EDIT_NOT_FOUND` or `FS_AMBIGUOUS_EDIT` from matching against newer content. Keeping this primitive on the provider seam also preserves backend-local locking and lets a future remote backend implement native compare-and-edit without forcing `ctx.fileContext` to pull the whole file through the policy layer.

This is a *text-storage* seam, deliberately half a level above byte-level fsspec (`cat`/`open` hand back raw bytes). UTF-8 decoding, binary/NUL rejection, guarded full-file writes, and guarded literal text edits live in the provider so the policy layer never touches raw bytes, reimplements cross-chunk decoding, or separates stale checks from the mutation critical section. Model-facing concepts still stay out of the provider: no line windows, numbered lines, rendered footers, or observed-state store leak down.

Deleted from `dsh-fs`: `readPage`, `FsExpectation`, `FsView`, `FsStateSource`, `FsReadRequest`, `FsTextLine`, line/window constants, `formatReadBody`, and the observed-state `WeakMap`. `applyEdit` is replaced by the narrower provider primitive `editText`, whose contract is version-guarded literal text mutation rather than policy-layer read authorization. The `FS_PARTIAL_OBSERVATION` code also leaves the `FsErrorCode` taxonomy: freshness authorization has no partial/full distinction, so nothing can raise it. `FsTargetKey` and `FsVersion` become branded opaque ids under the existing [branded-ids RFC](../../implemented/architecture/2026-06-20-branded-ids.md).

## Policy Contract

`@deepseek-ai/dsh-file-context` registers concrete service `ctx.fileContext` and injects `fs`. It is a concrete service, not a seam: it owns the read-windowing and write/edit freshness policy that does not belong on the `FileSystem` provider base class (where a sandboxed/remote backend would otherwise inherit model-facing observation policy it has no business carrying).

Observed state lives here as `WeakMap<owner, Map<targetKey, { version }>>`. An entry exists iff the owner has read that target through `ctx.fileContext.read`, so its presence *is* the read record — there is no separate `hasRead` flag. The owner is still derived structurally from `{ agent?: { session? } }`, but that shape no longer belongs to `dsh-fs`.

`read(target, request, exec?, signal?)` is the only read path used by the model-facing `read` tool. It stats the target, rejects absent/non-regular targets, chooses `readText` or `streamText` from `FsInfo`, builds the requested line window from text chunks, records `{ version: info.version }`, and returns the structured outcome that the tool renders.

`write(target, content, exec?, signal?)` uses freshness policy: no recorded read calls `writeText({ kind: 'createIfAbsent' })`, so only new files can be created blindly; a recorded read calls `writeText({ kind: 'replaceIfVersion', version: vObserved })`, so existing files are replaced only if they are unchanged since the read. A successful write refreshes recorded state from the returned outcome or a post-write `stat`.

`edit(target, edit, exec?, signal?)` requires a recorded read at `vObserved`, then calls `ctx.fs.editText(target, edit, { version: vObserved })` and refreshes recorded state from the returned version. `ctx.fileContext` does not implement literal replacement itself; it authorizes the operation and passes the observed version to the provider. The provider owns the mutation critical section, so concurrent edits based on the same observed version remain one-wins/one-stale rather than being merged or re-applied. If a backend needs a defensive whole-file edit cap, it should surface that as the same filesystem error taxonomy, but large model-facing reads should stream instead of failing just because the file is large.

## Tool Contract

`dsh-tool-fs` keeps the same schemas and prompt surface. `read` still exposes `file_path`, `offset`, and `limit`; `write` and `edit` are unchanged.

The tool package only validates model args, calls `ctx.fileContext`, and renders results (`N: text`, footer, `<path>/<content>` envelope). The no-bypass rule is part of the contract: a model-facing `read` must call `ctx.fileContext.read`, never `ctx.fs.readText` or `ctx.fs.streamText`, so every successful read records observed-state before rendering.

Direct `ctx.fs` calls are still allowed for non-tool consumers. They are explicit escape hatches: a direct `ctx.fs.readText` records no observed-state, so a later `ctx.fileContext.edit` rejects with `FS_NOT_OBSERVED` until the file is read through `ctx.fileContext`.

## Concurrency Boundary

In-process updates are safe: the local backend keeps the existing per-target mutation lock, so version-check-then-rename is serialized and a losing update sees `FS_STALE_VERSION`.

In-process creates are guarded by the same per-target mutation lock: two callers racing with `createIfAbsent` serialize, one creates, and the next sees the target exists and receives `FS_NOT_OBSERVED`. Cross-process creates are best-effort only; a local stat-then-rename guard cannot make portable create-exclusive guarantees across all future backends.

Cross-process writes are best-effort freshness plus atomic replacement: `mtime:size` usually catches editor saves, but same-tick same-size writes can miss; atomic temp+rename prevents torn files but not every lost update.

## Supersedes

This RFC reverses two decisions from [filesystem-capability-seam](../../implemented/architecture/2026-06-17-filesystem-capability-seam.md) and narrows a third:

- Read-before-write/edit policy moves out of `ctx.fs` and into `ctx.fileContext`.
- Text reads no longer return backend-numbered line records or `full`/`partial` views; authorization is based on version freshness, so a windowed read can authorize edit when the file is unchanged.
- Literal edit no longer sits behind the old `applyEdit` API that mixed backend mutation with seam-owned observation policy. It remains a provider primitive as `editText`, because version guard + literal match + atomic rewrite must stay inside the provider's mutation critical section.

It keeps the interface/implementation/consumer discipline, consumer-never-imports-backend rule, backend-defined target/version/display metadata, atomic local writes, and the shared `FsError` taxonomy.

## Acceptance Criteria

- `dsh-fs` exposes exactly `resolve`/`stat`/`readText`/`streamText`/`writeText`/`editText`; `stat` returns `FsInfo | undefined`; `writeText` uses `FsWriteExpectation` (`createIfAbsent` or `replaceIfVersion`); removed types/primitives are gone, and the old `applyEdit` API is replaced by `editText`.
- `dsh-file-context` registers `ctx.fileContext`, owns observed-state plus `read`/`write`/`edit` policy, injects `fs`, and has HMR/disposal coverage.
- `dsh-tool-fs` injects `fileContext`; model-facing schemas stay byte-for-byte unchanged; the no-bypass contract and escape-hatch contract are documented and tested.
- Windowed read authorizing edit is shown to fail on the pre-refit code and pass after the refit. Existing version-CAS behavior is preserved with a regression test; it is not claimed as a pre-refit failure. An edit based on a stale read must report `FS_STALE_VERSION` before attempting literal matching.
- `dsh-fs-local` carries no line, view, or `formatReadBody` logic; it does carry provider-level `editText` logic.
- Docs and generated artifacts are updated: `docs/architecture.md`, `packages/README.md`, fs package READMEs, `docs/core-data-structures/filesystem.md`, affected `type-equiv` blocks and `scripts/type-equiv.manifest.json`, Cordis catalog, module graph, and doc references.
- Gates stay green: normal `doc-sync`, `pnpm run knip`, and `pnpm run test:coverage` with 100% per-file coverage.

## Risks

- Adds a fourth fs package and a new service. This is intentional: it is the previously deferred policy layer, not a second abstract backend seam.
- Direct `ctx.fs` use can surprise callers who later use `ctx.fileContext`. The failure is explicit (`FS_NOT_OBSERVED`) and documented.
- Large-file line windowing moves from the backend to `ctx.fileContext.read`; text decoding and binary rejection stay in `ctx.fs.streamText`, so this is relocation of windowing only, not a second text-IO implementation.
- Keeping `editText` in the provider seam means every backend must implement the literal replacement contract. This is intentional: the operation is not pure storage, but stale guard + literal match + atomic rewrite is the unit that must stay together for correct error attribution and concurrency behavior. The contract should stay narrow and text-only so future backends can implement it natively or by whole-file rewrite.
- Freshness permits full-file `write` after a windowed read. That is weaker than the old view check, but avoids making large files impossible to edit; prompt guidance should still discourage blind full replaces.
