# @deepseek-ai/dsh-fs-local

The **local-filesystem implementation** of the `ctx.fs` seam ([`@deepseek-ai/dsh-fs`](../fs)). Backs the four `FileSystem` primitives with the host filesystem; loading it as a plugin populates `ctx.fs`.

```ts ignore-check
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'

await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
// ctx.fs is now the local backend; load @deepseek-ai/dsh-tool-fs to expose read/write/edit to the model.
```

## Behavior

- **`resolve(path)`** — relative paths resolve from `config.cwd` (default `process.cwd()`). The `targetKey` is the file's `realpath`, so two input paths reaching the same file through symlinks share one identity, and writes/edits land on the link target (preserving the link). A not-yet-existing path uses the realpathed parent directory plus basename when the parent exists; only an unresolvable parent falls back to the absolute path. `displayPath` is the absolute (un-resolved) path.
- **`readPage`** — UTF-8 only. A fast path (`readFile`) handles files under `FAST_PATH_MAX_SIZE` (10 MB); larger files stream with a capped line buffer so a newline-free giant file can't exhaust memory. Invalid UTF-8 and NUL-byte samples are rejected (`FS_NOT_TEXT`). Output is bounded to `READ_LIMIT` (2000) lines, `READ_MAX_BYTES` (50 KB), and `READ_MAX_LINE_LENGTH` (2000) chars per line; hitting any bound records a `partial` view. The `version` is `mtimeMs:size`.
- **`createOrReplace`** — atomic: writes to a temp file opened exclusively (`wx`, `0o600`) inside a randomly-named private staging dir (`0o700`) next to the target, fsyncs, then renames over the target. An existing file's mode is preserved, while new files default to `0o600`. Honors the `FsExpectation`: an `observed` write must match the recorded version (else `FS_STALE_VERSION`); a `partial` write onto an existing file is rejected (`FS_PARTIAL_OBSERVATION`); an `unobserved` write onto an existing file is rejected (`FS_NOT_OBSERVED`).
- **`applyEdit`** — atomic literal read-modify-write over the same primitive. Verifies the expected version, LF-normalizes for matching, restores the file's dominant CRLF/LF style, and rejects empty `oldString` / zero matches (`FS_EDIT_NOT_FOUND`) or ambiguous multi-matches without `replace_all` (`FS_AMBIGUOUS_EDIT`).

## `cwd` is not a sandbox

`config.cwd` is a resolution default, not a containment boundary — absolute paths and `..` escape it. Enforce containment with a stricter `ctx.fs` backend or a permission plugin on the `tools/execute` waterfall. See [the filesystem capability-seam RFC's Risks section](../../../docs/rfc/implemented/architecture/2026-06-17-filesystem-capability-seam.md#risks).

The raw I/O lives in `src/fsio.ts` (Cordis-free, independently unit-tested); `src/index.ts` is the thin service wiring.
