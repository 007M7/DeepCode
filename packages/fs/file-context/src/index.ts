/**
 * The file-context policy layer (`ctx.fileContext`): a concrete service that
 * owns model-facing read windowing and write/edit freshness on top of the
 * `ctx.fs` provider seam. It is NOT a swappable seam — it is the previously
 * deferred policy layer that does not belong on the `FileSystem` provider base
 * class (where a sandboxed/remote backend would otherwise inherit model-facing
 * observation policy it has no business carrying).
 *
 * ## Observed state IS the read record
 *
 * Observed state lives here as `WeakMap<owner, Map<targetKey, { version }>>`. An
 * entry exists iff the owner has read that target through {@link read}, so its
 * presence *is* the read record — there is no separate `hasRead` flag. The owner
 * is derived structurally from `{ agent?: { session? } }` and held weakly, so a
 * collected session frees its state; disposal drops everything (HMR safety).
 *
 * ## Freshness, not full/partial views
 *
 * Authorization is based on version freshness only. A windowed read records the
 * file's version, and any later write/edit at that version is authorized — a
 * model that read lines 100-150 of a large file can still edit line 120 as long
 * as the file is unchanged. There is no `full`/`partial` distinction: the bytes
 * the edit matches must merely come from the version the model read, which the
 * provider's stale guard enforces.
 *
 * ## The no-bypass contract
 *
 * A model-facing read MUST go through {@link read} (never `ctx.fs.readText`/
 * `streamText` directly), so every successful read records observed state before
 * the tool renders. Direct `ctx.fs` calls are allowed for non-tool consumers but
 * record nothing, so a later {@link edit} rejects with `FS_NOT_OBSERVED` until
 * the file is read through `ctx.fileContext`.
 *
 * @module @deepseek-ai/dsh-file-context
 */

import { Context, Service } from 'cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion, FsEditRequest, FsEditOutcome, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { buildWindow } from './window.ts'
import type { FileContextExec, FileReadRequest, FileReadOutcome } from './types.ts'

export type { FileTextLine, ReadWindow, WindowResult } from './window.ts'
export { READ_MAX_BYTES, READ_MAX_LINE_LENGTH, buildWindow } from './window.ts'
export type { FileContextExec, FileReadRequest, FileReadOutcome } from './types.ts'

/** Files at or above this size stream; smaller files read whole into memory. */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

declare module 'cordis' {
  interface Context {
    fileContext: FileContext
  }
}

/** What an owner has observed about one target: just the version it last saw. */
interface ObservedState {
  version: FsVersion
}

/**
 * The file-context policy service. Injects `fs`, registers as `ctx.fileContext`,
 * and is the only read/write/edit path the model-facing tools use.
 */
export class FileContext extends Service {
  static inject = ['fs']

  /**
   * Observed-file state, keyed first by the owner object (weakly held, so a
   * collected session frees its state), then by {@link FsTarget.targetKey}. An
   * entry's PRESENCE is the read record.
   */
  private observed = new WeakMap<object, Map<string, ObservedState>>()

  constructor(ctx: Context) {
    super(ctx, 'fileContext')
    ctx.effect(() => () => {
      // Drop all recorded state on disposal so a reloaded service starts clean
      // (HMR safety). The WeakMap itself would be GC'd, but replacing it makes
      // the release observable and immediate for tests.
      this.observed = new WeakMap()
    }, 'fileContext observed-state teardown')
  }

  /**
   * Derive the observed-state owner from an execution context — normally the
   * active agent session. `undefined` when no owner can be derived (e.g. a
   * direct tool call with no agent); such calls read freely but cannot satisfy
   * the write/edit prior-observation policy.
   */
  owner(exec?: FileContextExec): object | undefined {
    return exec?.agent?.session
  }

  private getObserved(owner: object, targetKey: string): ObservedState | undefined {
    return this.observed.get(owner)?.get(targetKey)
  }

  private record(owner: object, targetKey: string, version: FsVersion): void {
    let byTarget = this.observed.get(owner)
    if (!byTarget) {
      byTarget = new Map()
      this.observed.set(owner, byTarget)
    }
    byTarget.set(targetKey, { version })
  }

  /**
   * Resolve a path into a stable {@link FsTarget}, delegating to the provider.
   * Exposed here so the model-facing tools never need to inject `ctx.fs`
   * directly — they resolve and then read/write/edit entirely through
   * `ctx.fileContext`.
   */
  async resolve(path: string): Promise<FsTarget> {
    return this.ctx.fs.resolve(path)
  }

  /**
   * Read a bounded line window from a target. Stats first (rejecting an absent
   * target with `FS_NOT_FOUND` and a non-regular one with `FS_NOT_REGULAR_FILE`),
   * chooses `readText` vs `streamText` by size, builds the window, and — when an
   * owner is derivable — records the version so a later write/edit is authorized.
   */
  async read(target: FsTarget, request: FileReadRequest, exec?: FileContextExec, signal?: AbortSignal): Promise<FileReadOutcome> {
    const info = await this.ctx.fs.stat(target, signal)
    if (!info) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')

    const chunks = info.size !== undefined && info.size >= STREAM_MIN_SIZE
      ? await this.ctx.fs.streamText(target, signal)
      : [await this.ctx.fs.readText(target, signal)]
    const window = await buildWindow(chunks, request, target.displayPath)

    const owner = this.owner(exec)
    if (owner) this.record(owner, target.targetKey, info.version)
    return {
      offset: request.offset,
      limit: request.limit,
      lines: window.lines,
      totalLines: window.totalLines,
      version: info.version,
      ...window.truncatedByBytes ? { truncatedByBytes: true } : {},
    }
  }

  /**
   * Create or fully replace a file. With no recorded read, writes
   * `createIfAbsent` (only new files can be created blindly); with a recorded
   * read, writes `replaceIfVersion` at the observed version (existing files are
   * replaced only if unchanged since the read). Refreshes recorded state from
   * the returned version on success.
   */
  async write(target: FsTarget, content: string, exec?: FileContextExec, signal?: AbortSignal): Promise<FsWriteOutcome> {
    const owner = this.owner(exec)
    const prior = owner ? this.getObserved(owner, target.targetKey) : undefined
    const outcome = await this.ctx.fs.writeText(
      target,
      content,
      prior ? { kind: 'replaceIfVersion', version: prior.version } : { kind: 'createIfAbsent' },
      signal,
    )
    if (owner) this.record(owner, target.targetKey, outcome.version)
    return outcome
  }

  /**
   * Apply a literal edit. Requires a recorded read by this owner (else
   * `FS_NOT_OBSERVED`); passes the observed version to `ctx.fs.editText` as the
   * stale guard and refreshes recorded state from the returned version. The
   * provider owns the mutation critical section and the literal match.
   */
  async edit(target: FsTarget, edit: FsEditRequest, exec?: FileContextExec, signal?: AbortSignal): Promise<FsEditOutcome> {
    const owner = this.owner(exec)
    const prior = owner ? this.getObserved(owner, target.targetKey) : undefined
    if (!owner || !prior) {
      throw new FsError(`edit requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED')
    }
    const outcome = await this.ctx.fs.editText(target, edit, { version: prior.version }, signal)
    this.record(owner, target.targetKey, outcome.version)
    return outcome
  }
}

export default FileContext
