# @deepseek-ai/dsh-fs-local

The **local-filesystem implementation** of the `ctx.fs` provider seam ([`@deepseek-ai/dsh-fs`](../fs)). Backs the six `FileSystem` primitives with the host filesystem; loading it as a plugin populates `ctx.fs`.

```ts ignore-check
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'

await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
// ctx.fs is now the local backend; load @deepseek-ai/dsh-file-context for policy
// and @deepseek-ai/dsh-tool-fs to expose read/write/edit to the model.
```

## Behavior

- **`resolve(path)`** — relative paths resolve from `config.cwd` (default `process.cwd()`). The `targetKey` is the file's `realpath`, so two input paths reaching the same file through symlinks share one identity, and writes/edits land on the link target (preserving the link). A not-yet-existing path uses the realpathed parent directory plus basename when the parent exists; only an unresolvable parent falls back to the absolute path. `displayPath` is the absolute (un-resolved) path.
- **`stat`** — returns `FsInfo` (`version` = `mtimeMs:size`, `type` of `file`/`directory`/`other`, byte `size`) or `undefined` when the target is absent.
- **`readText` / `streamText`** — UTF-8 only. `readText` reads the whole file; `streamText` streams it in chunks (cross-chunk decoding) so a huge file never has to be held whole in memory. Both reject invalid UTF-8 and NUL-byte binary samples (`FS_NOT_TEXT`) and non-regular targets. The policy layer (`ctx.fileContext`) decides which to call by size and owns the line windowing.
- **`writeText`** — atomic: writes to a temp file opened exclusively (`wx`, `0o600`) inside a randomly-named private staging dir (`0o700`) next to the target, fsyncs, then renames over the target. An existing file's mode is preserved, while new files default to `0o600`. Honors the `FsWriteExpectation`: `createIfAbsent` creates a missing target and rejects an existing one (`FS_NOT_OBSERVED`); `replaceIfVersion` replaces only at the observed version (a missing target or mismatch is `FS_STALE_VERSION`).
- **`editText`** — atomic literal read-modify-write over the same primitive, serialized per target by a mutation lock. Verifies the expected version BEFORE literal matching (a stale edit reports `FS_STALE_VERSION`, never `FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT` against newer content), LF-normalizes for matching, restores the file's dominant CRLF/LF style, and rejects empty `oldString` / zero matches (`FS_EDIT_NOT_FOUND`) or ambiguous multi-matches without `replace_all` (`FS_AMBIGUOUS_EDIT`).

## `cwd` is not a sandbox

`config.cwd` is a resolution default, not a containment boundary — absolute paths and `..` escape it. Enforce containment with a stricter `ctx.fs` backend or a permission plugin on the `tools/execute` waterfall. See [the filesystem capability-seam RFC's Risks section](../../../docs/rfc/implemented/architecture/2026-06-17-filesystem-capability-seam.md#risks).

The raw I/O lives in `src/fsio.ts` (Cordis-free, independently unit-tested); `src/index.ts` is the thin service wiring.
