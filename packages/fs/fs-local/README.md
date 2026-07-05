# @deepseek-ai/dsh-fs-local

The **local-filesystem implementation** of the `ctx.fs` provider seam ([`@deepseek-ai/dsh-fs`](../fs)). Backs the seven `FileSystem` primitives with the host filesystem; loading it as a plugin populates `ctx.fs`.

```ts ignore-check
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'

await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
// ctx.fs is now the local backend; load @deepseek-ai/dsh-fs-policy for the
// freshness policy gate and @deepseek-ai/dsh-tool-fs to expose read/write/edit.
```

## Behavior

- **`resolve(path, opts?)`** — a relative `path` resolves against `opts.cwd` when the caller supplies one (the model-facing tools pass the calling agent's session cwd — see [the per-session cwd RFC](../../../docs/rfc/implemented/architecture/2026-07-02-fs-per-session-cwd.md)), else `config.cwd` (default `process.cwd()`); an absolute `path` ignores both. The `targetKey` is the file's `realpath`, so two input paths reaching the same file through symlinks share one identity, and writes/edits land on the link target (preserving the link). A not-yet-existing path uses the realpathed parent directory plus basename when the parent exists; only an unresolvable parent falls back to the absolute path. `displayPath` is the absolute (un-resolved) path.
- **`stat`** — returns `FsInfo` (`version` = `mtimeMs:size`, `type` of `file`/`directory`/`other`, byte `size`) or `undefined` when the target is absent.
- **`readText` / `streamText`** — UTF-8 only. `readText` reads the whole file; `streamText` streams it in chunks (cross-chunk decoding) so a huge file never has to be held whole in memory. Both reject invalid UTF-8 and NUL-byte binary samples (`FS_NOT_TEXT`) and non-regular targets. The `read` tool (`@deepseek-ai/dsh-tool-fs`) decides which to call by size and owns the line windowing.
- **`listDir`** — lists one directory level in stable `name.localeCompare()` order. Each entry carries the child basename, type, resolved child target (`displayPath` under the listed directory, `targetKey` as the realpath identity), and cheap stat metadata (`version`, plus `size` for regular files). It never opens or decodes file contents. Missing targets report `FS_NOT_FOUND`, file/special-file targets report `FS_NOT_DIRECTORY`, aborted calls report `FS_ABORTED`, permission failures report `FS_PERMISSION_DENIED`, and other listing or child metadata I/O failures report `FS_IO_ERROR`. Broken/disappeared children are returned as `other` without metadata, but permission/IO failures while resolving a child fail the whole listing with a structured `FsError`.
- **`writeText`** — atomic: writes to a temp file opened exclusively (`wx`, `0o600`) inside a randomly-named private staging dir (`0o700`) next to the target, fsyncs, then renames over the target. An existing file's mode is preserved, while new files default to `0o600`. The `expected` guard is OPTIONAL: omitting it unconditionally creates-or-overwrites; `createIfAbsent` creates a missing target and rejects an existing one (`FS_NOT_OBSERVED`); `replaceIfVersion` replaces only at the observed version (a missing target or mismatch is `FS_STALE_VERSION`).
- **`editText`** — atomic literal read-modify-write over the same primitive, serialized per target by a mutation lock. The `expected` guard is OPTIONAL: when supplied it verifies the version BEFORE literal matching (a stale edit reports `FS_STALE_VERSION`, never `FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT` against newer content); omitting it edits the current content unconditionally. A missing target reports `FS_STALE_VERSION` either way. LF-normalizes for matching, restores the file's dominant CRLF/LF style, and rejects empty `oldString` / zero matches (`FS_EDIT_NOT_FOUND`) or ambiguous multi-matches without `replace_all` (`FS_AMBIGUOUS_EDIT`).

## `cwd` is not a sandbox

`config.cwd` is a resolution default, not a containment boundary — absolute paths and `..` escape it. Enforce containment with a stricter `ctx.fs` backend or a permission plugin on the `tools/execute` waterfall. See [the filesystem capability-seam RFC's Consequences section](../../../docs/rfc/implemented/architecture/2026-06-17-filesystem-capability-seam.md#consequences).

The raw I/O lives in `src/fsio.ts` (Cordis-free, independently unit-tested); `src/index.ts` is the thin service wiring.
