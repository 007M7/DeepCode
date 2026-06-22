/**
 * Local-filesystem implementation of the `ctx.fs` seam. {@link LocalFileSystem}
 * subclasses {@link FileSystem} and backs the four primitives with the host
 * filesystem via {@link module:@deepseek-ai/dsh-fs-local/fsio}. Path resolution
 * uses `realpath`, so the stable `targetKey` is the real file identity (two
 * input paths reaching the same file through symlinks share one key, and writes
 * land on the link target — preserving the link).
 *
 * Future sandboxed/remote/virtual backends are sibling packages implementing
 * the same interface; loading this one populates `ctx.fs`.
 *
 * @module @deepseek-ai/dsh-fs-local
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsExpectation,
  FsReadOutcome,
  FsReadRequest,
  FsTarget,
  FsVersion,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import {
  applyLiteralEdit,
  probe,
  readForEdit,
  readTextPage,
  resolveLocalTarget,
  restoreLineEndings,
  writeFileAtomic,
} from './fsio.ts'
import type { FsIoInternals } from './fsio.ts'

export {
  FAST_PATH_MAX_SIZE,
  READ_LIMIT,
  READ_MAX_BYTES,
  READ_MAX_LINE_LENGTH,
  applyLiteralEdit,
  formatReadBody,
  probe,
  readForEdit,
  readTextPage,
  resolveLocalTarget,
  restoreLineEndings,
  writeFileAtomic,
} from './fsio.ts'
export type { FsIoInternals, LineEndings, LocalTarget, PathInfo, ReadPageResult } from './fsio.ts'

/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
}

type ResolvedConfig = Required<Config>

/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam RFC); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
export class LocalFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
  })

  readonly config: ResolvedConfig
  /** Test seam forwarded to fsio (force streaming path, pin temp names). */
  internals: FsIoInternals = {}
  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave, making concurrent writes/edits deterministically
   * ordered (one wins, the rest see the new version and reject as stale). */
  private locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
  }

  /** Run `op` with exclusive access to `targetKey` (FIFO per key). */
  private async withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    // Keep the chain alive but swallow this op's result/throw for the *next* waiter.
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) {
        this.locks.delete(targetKey)
      }
    }
  }

  override async resolve(path: string): Promise<FsTarget> {
    const local = await resolveLocalTarget(this.config.cwd, path)
    return { inputPath: path, targetKey: local.targetKey, displayPath: local.displayPath }
  }

  override async readPage(target: FsTarget, request: FsReadRequest, signal?: AbortSignal): Promise<FsReadOutcome> {
    const result = await readTextPage(
      { displayPath: target.displayPath, targetKey: target.targetKey },
      request,
      signal,
      this.internals,
    )
    return {
      offset: request.offset,
      limit: request.limit,
      lines: result.lines,
      totalLines: result.totalLines,
      version: result.version,
      view: result.view,
      ...result.truncatedByBytes ? { truncatedByBytes: true } : {},
    }
  }

  override async createOrReplace(
    target: FsTarget,
    content: string,
    expected: FsExpectation,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      if (existing && !existing.isFile) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected.kind === 'observed') {
        // Stale guard: the file must still be at the version the owner observed.
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected.kind === 'partial') {
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        throw new FsError(`cannot overwrite existing "${target.displayPath}" after only a partial read`, 'FS_PARTIAL_OBSERVATION')
      } else if (existing) {
        // Unobserved write onto an existing file: a blind overwrite — require a read first.
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }

      await writeFileAtomic(target.targetKey, content, existing?.mode, signal, this.internals)
      const after = await probe(target.targetKey)
      return {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(after, target),
      }
    })
  }

  override async applyEdit(
    target: FsTarget,
    edit: FsEditRequest,
    expected: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      if (!existing.isFile) throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = await readForEdit(target.targetKey, target.displayPath, signal)
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const content = restoreLineEndings(edited.content, original.lineEndings)
      await writeFileAtomic(target.targetKey, content, existing.mode, signal, this.internals)

      const after = await probe(target.targetKey)
      return {
        replacements: edited.replacements,
        replaceAll: edit.replaceAll,
        version: this.versionAfterWrite(after, target),
      }
    })
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: string } | null, target: FsTarget): string {
    if (after) return after.version
    return `missing:${target.targetKey}`
  }
}

export default LocalFileSystem
