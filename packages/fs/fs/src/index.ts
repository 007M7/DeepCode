/**
 * The filesystem provider seam (`ctx.fs`): an abstract service defining the text-storage
 * primitives a backend provides — resolve a path into a stable target, stat its metadata,
 * read/stream its text, write it atomically with an explicit intent, and apply a guarded
 * literal edit — without saying how.
 * @module @deepseek-ai/dsh-fs
 */

import { Context, Service } from 'cordis'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
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
  FsDirEntry,
  FsErrorCode,
  FsInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    fs: FileSystem
  }

  interface Events {
    /**
     * Single-slot decision: produce the write intent for the next {@link
     * FileSystem.writeText}.
     *
     * @param target - the resolved target about to be written.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
    /**
     * Single-slot decision: produce the optional version guard for the next {@link
     * FileSystem.editText}.
     *
     * @param target - the resolved target about to be edited.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
    /**
     * Record that an actor observed a target at a version, after a successful read/write/edit.
     *
     * @param target - the target that was read/written/edited.
     * @param version - the version the actor now holds as its observation.
     * @param actor - the observing tool-execution context; undefined records nothing useful.
     * @mode emit
     */
    'fs/observed'(target: FsTarget, version: FsVersion, actor: object | undefined): void
  }
}

/**
 * Abstract filesystem provider service. Subclass, implement the seven storage primitives, and
 * load the subclass as a plugin — it registers as `ctx.fs` (one implementation per context;
 * loading a second throws, cordis' standard duplicate-service behavior).
 */
export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May perform I/O (a
   * remote/sandboxed backend may need a round-trip to map a path to a stable identity), hence
   * async even though the local backend only normalizes + realpaths.
   *
   * @param path - the path to resolve; relative paths resolve against `opts.cwd`.
   * @param opts - `cwd` overrides the backend's default base for relative paths.
   * @returns the stable target; the same file yields the same `targetKey`.
   */
  abstract resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget>

  /**
   * Return target metadata, or `undefined` when the target does not exist.
   * @param target - the resolved target to stat.
   * @param signal - aborts the metadata round-trip.
   * @returns metadata only, never content; undefined for an absent target.
   */
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

  /**
   * Read the whole regular text file as a single decoded string.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @returns the full decoded UTF-8 content.
   */
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

  /**
   * Stream the whole regular text file as decoded text chunks (same text
   * semantics as {@link readText}, for large files). The backend owns
   * cross-chunk UTF-8 decoding and binary rejection so the policy layer never
   * touches raw bytes.
   * @param target - the resolved target to read.
   * @param signal - aborts the stream, including between chunks.
   * @returns the chunk iterable, decoded and validated like {@link readText}.
   */
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

  /**
   * List direct children of a directory in stable name order. Returns resolved
   * child targets plus cheap metadata only; never reads file contents.
   * @param target - the resolved directory target.
   * @param signal - aborts the listing.
   * @returns one entry per direct child, in stable name order.
   */
  abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

  /**
   * Create or fully replace a UTF-8 text file atomically. `expected` is the
   * create-vs-replace decision and stale guard when supplied; OMITTING it is an
   * unconditional create-or-overwrite (the bare provider — no version guard, no
   * read-first requirement). Atomic either way.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before the atomic rename takes effect.
   * @returns the outcome, including the version the write produced.
   */
  abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>

  /**
   * Apply a literal edit to an existing UTF-8 text file.
   *
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before the atomic rename takes effect.
   * @returns the outcome, including the version the edit produced.
   */
  abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>
}

export default FileSystem
