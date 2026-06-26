/**
 * The filesystem provider seam (`ctx.fs`): an abstract service defining the
 * text-storage primitives a backend provides — resolve a path into a stable
 * target, stat its metadata, read/stream its text, write it atomically with an
 * explicit expectation, and apply a guarded literal edit — without saying HOW.
 * Implementations subclass {@link FileSystem} and register themselves as the
 * `fs` service; `@deepseek-ai/dsh-fs-local` (the host filesystem) is the first.
 * Future implementations swap in sandboxed, remote, virtual, or project-scoped
 * backends without touching the model-facing tool schemas
 * (`@deepseek-ai/dsh-tool-fs`).
 *
 * The split mirrors the bash seam (`BashExecutor`/`LocalBashExecutor`). See the
 * capability-seam RFC for why a swappable capability is three (here four)
 * packages.
 *
 * ## This is a provider seam, not the policy layer
 *
 * `ctx.fs` is deliberately close to fsspec-style storage primitives. It owns
 * UTF-8 decoding, binary/NUL rejection, atomic full-file writes, and the
 * version-guarded literal-edit critical section — but NOT line windows,
 * numbered lines, rendered footers, or observed-state. Those model-facing
 * read-windowing and read-before-write/edit policies live one layer up in the
 * concrete `ctx.fileContext` service (`@deepseek-ai/dsh-file-context`), so a
 * sandboxed/remote backend inherits no model-facing observation policy it has
 * no business carrying.
 *
 * `editText` stays on this seam (not composed in the policy layer from a read
 * plus a write) because version guard + literal match + atomic rewrite must
 * stay inside one mutation critical section for correct error attribution and
 * one-wins/one-stale concurrency, and a remote backend may implement it as a
 * native compare-and-edit.
 *
 * @module @deepseek-ai/dsh-fs
 */

import { Context, Service } from 'cordis'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteExpectation,
  FsWriteOutcome,
} from './types.ts'

export {
  FsError,
  FsTargetKey,
  FsVersion,
} from './types.ts'
export type {
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsTarget,
  FsWriteExpectation,
  FsWriteOutcome,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    fs: FileSystem
  }
}

/**
 * Abstract filesystem provider service. Subclass, implement the six text-storage
 * primitives, and load the subclass as a plugin — it registers as `ctx.fs` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every backend must honor:
 * - {@link resolve} returns a stable {@link FsTarget}; the same underlying file
 *   reached by different input paths must yield the same `targetKey` so stale
 *   guards and target lookup agree across paths (e.g. through symlinks).
 * - {@link stat} returns {@link FsInfo} metadata (never content) or `undefined`
 *   when the target is absent.
 * - {@link readText}/{@link streamText} read the whole regular text file (the
 *   stream for large files); both own regular-file checks, UTF-8 decoding,
 *   binary/NUL rejection, and `FS_NOT_TEXT`.
 * - {@link writeText} is atomic temp-file + rename honoring the
 *   {@link FsWriteExpectation}.
 * - {@link editText} verifies `expected.version` BEFORE literal matching (so a
 *   stale edit reports `FS_STALE_VERSION`, not `FS_EDIT_NOT_FOUND`/
 *   `FS_AMBIGUOUS_EDIT` against newer content), then applies literal replacement
 *   and writes atomically — all inside one mutation critical section.
 */
export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May
   * perform I/O (a remote/sandboxed backend may need a round-trip to map a path
   * to a stable identity), hence async even though the local backend only
   * normalizes + realpaths.
   */
  abstract resolve(path: string): Promise<FsTarget>

  /** Return target metadata, or `undefined` when the target does not exist. */
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

  /** Read the whole regular text file as a single decoded string. */
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

  /**
   * Stream the whole regular text file as decoded text chunks (same text
   * semantics as {@link readText}, for large files). The backend owns
   * cross-chunk UTF-8 decoding and binary rejection so the policy layer never
   * touches raw bytes.
   */
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

  /**
   * Create or fully replace a UTF-8 text file atomically, honoring `expected`
   * as the create-vs-replace decision and stale guard.
   */
  abstract writeText(target: FsTarget, content: string, expected: FsWriteExpectation, signal?: AbortSignal): Promise<FsWriteOutcome>

  /**
   * Apply a literal edit to an existing UTF-8 text file. Verifies
   * `expected.version` as the stale guard BEFORE literal matching, then applies
   * the replacement and writes atomically — one mutation critical section.
   */
  abstract editText(target: FsTarget, edit: FsEditRequest, expected: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>
}

export default FileSystem
