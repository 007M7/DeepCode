/**
 * Local-filesystem implementation of the `ctx.fs` provider seam.
 * {@link LocalFileSystem} subclasses {@link FileSystem} and backs the seven
 * text-storage primitives with the host filesystem via
 * {@link module:@deepseek-ai/dsh-fs-local/fsio}. Path resolution uses
 * `realpath`, so the stable `targetKey` is the real file identity (two input
 * paths reaching the same file through symlinks share one key, and writes land
 * on the link target — preserving the link).
 *
 * Future sandboxed/remote/virtual backends are sibling packages implementing
 * the same interface; loading this one populates `ctx.fs`.
 *
 * @module @deepseek-ai/dsh-fs-local
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { FileSystem, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import {
  applyLiteralEdit,
  listDirectory,
  normalizeLineEndings,
  probe,
  readForEdit,
  readTextForDiff,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from './fsio.ts'
import type { FsIoInternals } from './fsio.ts'

export {
  applyLiteralEdit,
  listDirectory,
  probe,
  readForEdit,
  readTextForDiff,
  readWholeText,
  resolveLocalTarget,
  restoreLineEndings,
  streamWholeText,
  writeFileAtomic,
} from './fsio.ts'
export type { FsIoInternals, LineEndings, LocalDirEntry, LocalTarget, PathInfo } from './fsio.ts'

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

  /** Validated config (schemastery applied the defaults before construction). */
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

  override async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    const local = await resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)
    return { targetKey: local.targetKey, displayPath: local.displayPath }
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const info = await probe(target.targetKey)
    if (!info) return undefined
    return { version: info.version, type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return readWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return Promise.resolve(streamWholeText({ displayPath: target.displayPath, targetKey: target.targetKey }, signal))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await listDirectory({ displayPath: target.displayPath, targetKey: target.targetKey }, signal)
    return entries.map(entry => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: entry.target.targetKey, displayPath: entry.target.displayPath },
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      if (existing && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      if (expected?.kind === 'replaceIfVersion') {
        // Stale guard: the file must still exist at the version the owner observed.
        if (!existing) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (existing.version !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        // createIfAbsent onto an existing file: a blind overwrite — require a read first.
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      // expected === undefined: unconditional create-or-overwrite (the bare
      // provider) — no version guard, no read-first requirement. Still atomic
      // (the per-target lock is unconditional), so the write is never torn.

      // Capture the prior text (the before/after diff basis) BEFORE the write.
      // `null` for a create (no existing file) OR an existing-but-undiffable
      // file (binary/invalid-UTF-8) — a null `before` gives no contextual-hunk
      // basis, so a consumer falls back to a whole-file diff (the tool still
      // renders a result-time diff card, not the raw result text).
      // TODO(overwrite-diff-bound): this reads the whole prior file into memory
      // for a UI-only diff; bound the pre-read and fall back to no contextual
      // basis above a size threshold (see the applied-hunk-diffs RFC non-goals).
      const before = existing ? await readTextForDiff(target.targetKey, signal) : null
      await writeFileAtomic(target.targetKey, content, existing?.mode, signal, this.internals)
      const after = await probe(target.targetKey)
      return {
        operation: existing ? 'update' : 'create',
        version: this.versionAfterWrite(after, target),
        before,
        // LF-normalized to share the diff basis with `before` (also LF): a CRLF
        // overwrite must not read as every line changed. Line-ending restoration
        // is a storage detail the applied-hunk diff ignores.
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(target.targetKey, async () => {
      const existing = await probe(target.targetKey)
      // Stale guard BEFORE literal matching: an edit based on an old read reports
      // FS_STALE_VERSION, not FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT against newer content.
      // A missing target reports FS_STALE_VERSION on BOTH paths (guarded and
      // unconditional) — one "cannot edit this target now" code.
      if (!existing) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      // expected === undefined: unconditional edit of the current content — no
      // version guard. Still inside the per-target lock, so the read→match→write
      // window is serialized and atomic.
      if (expected && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = await readForEdit(target.targetKey, target.displayPath, signal)
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const content = restoreLineEndings(edited.content, original.lineEndings)
      await writeFileAtomic(target.targetKey, content, existing.mode, signal, this.internals)

      const after = await probe(target.targetKey)
      return {
        version: this.versionAfterWrite(after, target),
        // The LF-normalized before/after text (the applied-hunk diff basis);
        // line-ending restoration is a storage detail the diff ignores.
        before: original.content,
        after: edited.content,
      }
    })
  }

  /* v8 ignore next 5 -- the post-write probe finding the file absent requires a
   * concurrent unlink between rename and stat; fall back to a sentinel version. */
  private versionAfterWrite(after: { version: FsVersion } | null, target: FsTarget): FsVersion {
    if (after) return after.version
    return FsVersion(`missing:${target.targetKey}`)
  }
}

export default LocalFileSystem
