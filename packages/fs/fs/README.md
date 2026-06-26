# @deepseek-ai/dsh-fs

The **filesystem provider seam**: an abstract `FileSystem` service (`ctx.fs`) defining the text-storage primitives a backend provides — resolve a path, stat metadata, read/stream text, write atomically, and apply a guarded literal edit — without saying HOW.

This package is the provider-seam layer of the four-layer filesystem stack, split so each concern can evolve (and be swapped) independently (see [the capability-seam RFC](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md), [the filesystem capability-seam RFC](../../../docs/rfc/implemented/architecture/2026-06-17-filesystem-capability-seam.md), and [the split-the-filesystem-seam RFC](../../../docs/rfc/implemented/simplification/2026-06-26-fsspec-style-fs-seam.md)):

| Layer | Package | Role |
|---|---|---|
| tool | `@deepseek-ai/dsh-tool-fs` | model-facing `read`/`write`/`edit` schemas + text rendering |
| policy | `@deepseek-ai/dsh-file-context` | `ctx.fileContext`: observed-state, read windowing, write/edit freshness |
| provider seam | `@deepseek-ai/dsh-fs` (this) | `ctx.fs`: text IO + guarded mutation primitives |
| provider | `@deepseek-ai/dsh-fs-local` | the host-filesystem implementation |

A future sandboxed, virtual, or remote backend implements this interface and the policy/tool layers don't change.

## Service API (`ctx.fs`)

A backend subclasses `FileSystem` and implements six primitives.

| Member | Semantics |
|---|---|
| `resolve(path)` | Resolve a path into a stable `FsTarget` (`inputPath`, opaque `targetKey`, `displayPath`). Async — a remote backend may need I/O. The same file via different paths must yield the same `targetKey`. |
| `stat(target, signal?)` | Return `FsInfo` metadata (`version`, `type`, optional `size`), or `undefined` when the target is absent. Never content. |
| `readText(target, signal?)` | Read the whole regular text file as one decoded string. Owns regular-file checks, UTF-8 decoding, binary/NUL rejection (`FS_NOT_TEXT`). |
| `streamText(target, signal?)` | Stream the same text as decoded chunks for large files (cross-chunk UTF-8 decoding stays here). |
| `writeText(target, content, expected, signal?)` | Atomic create/replace honoring the `FsWriteExpectation` (`createIfAbsent` or `replaceIfVersion`). |
| `editText(target, edit, expected, signal?)` | Version-guarded literal edit. Verifies `expected.version` BEFORE matching, then applies the replacement and writes atomically — one mutation critical section. |

## A provider seam, not the policy layer

`ctx.fs` is deliberately close to fsspec-style storage primitives — half a level above byte-level `cat`/`open`, because it decodes text and rejects binaries so the policy layer never touches raw bytes. It owns UTF-8 decoding, binary rejection, atomic writes, and the version-guarded literal-edit critical section. It does **not** own line windows, numbered lines, rendered footers, or observed-state — those model-facing read-windowing and read-before-write/edit policies live one layer up in `ctx.fileContext` ([`@deepseek-ai/dsh-file-context`](../file-context)), so a sandboxed/remote backend inherits no model-facing observation policy.

`editText` stays on this seam (not composed in the policy layer from a read plus a write) because version guard + literal match + atomic rewrite must stay inside one critical section for correct error attribution and one-wins/one-stale concurrency, and a remote backend may implement it as a native compare-and-edit.

## Vocabulary

`FsTargetKey` / `FsVersion` are branded opaque ids ([the branded-ids RFC](../../../docs/rfc/implemented/architecture/2026-06-20-branded-ids.md)) — consumers must not parse `targetKey` or interpret `version`; only `displayPath` is for model/UI output. `FsWriteExpectation` is the explicit write intent (`createIfAbsent` creates a missing target and rejects an existing one with `FS_NOT_OBSERVED`; `replaceIfVersion` replaces only at the observed version, else `FS_STALE_VERSION`). Failures throw `FsError` (extends `HarnessError`, [the structured error taxonomy RFC](../../../docs/rfc/implemented/architecture/2026-06-11-structured-error-taxonomy.md)) carrying a stable `FsErrorCode` (`FS_NOT_FOUND`, `FS_NOT_TEXT`, `FS_NOT_REGULAR_FILE`, `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_AMBIGUOUS_EDIT`, `FS_EDIT_NOT_FOUND`, `FS_ABORTED`); the tool registry surfaces `{ name, code }` on `isError` results. See `src/types.ts` for the full contracts.
