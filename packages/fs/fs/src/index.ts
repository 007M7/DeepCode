/**
 * The filesystem seam (`ctx.fs`): an abstract service defining WHAT a
 * filesystem backend does — resolve paths into stable targets, read bounded
 * text pages, create/replace files, and apply literal edits — without saying
 * HOW. Implementations subclass {@link FileSystem} and register themselves as
 * the `fs` service; `@deepseek-ai/dsh-fs-local` (the host filesystem) is the
 * first. Future implementations swap in sandboxed, remote, virtual, or
 * project-scoped backends without touching the tool schemas that consume them
 * (`@deepseek-ai/dsh-tool-fs`).
 *
 * The split mirrors the bash seam (`BashExecutor`/`LocalBashExecutor`). See
 * the capability-seam RFC for why a swappable capability is three packages.
 *
 * ## Read-before-write/edit lives here, not in the tools
 *
 * Write/edit safety depends on backend-defined target identity and version
 * tokens, so the seam — not the consumer — records what each owner has observed
 * and enforces the policy. The base class owns owner derivation, the file-state
 * store, and the decision of *which* {@link FsExpectation} to hand a backend;
 * the backend owns version comparison and the actual I/O. A consumer passes its
 * execution context through {@link read}/{@link write}/{@link edit} and never
 * touches the cache, owner key, or version tokens.
 *
 * @module @deepseek-ai/dsh-fs
 */

import { Context, Service } from 'cordis'
import { FsError } from './types.ts'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsExecContext,
  FsExpectation,
  FsReadOutcome,
  FsReadRequest,
  FsTarget,
  FsVersion,
  FsWriteOutcome,
  FileState,
} from './types.ts'

export {
  FsError,
} from './types.ts'
export type {
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsExecContext,
  FsExpectation,
  FsReadOutcome,
  FsReadRequest,
  FsStateSource,
  FsTarget,
  FsTextLine,
  FsVersion,
  FsView,
  FsWriteOutcome,
  FileState,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    fs: FileSystem
  }
}

/**
 * Abstract filesystem service. Subclass, implement the four backend primitives
 * ({@link resolve}, {@link readPage}, {@link createOrReplace},
 * {@link applyEdit}), and load the subclass as a plugin — it registers as
 * `ctx.fs` (one implementation per context; loading a second throws, cordis'
 * standard duplicate-service behavior).
 *
 * Consumers call the concrete public API ({@link read}/{@link write}/
 * {@link edit}), which derives the file-state owner, enforces the
 * read-before-write/edit policy, and refreshes recorded state — then delegates
 * the actual I/O to the backend primitives.
 *
 * Semantics every backend must honor:
 * - {@link resolve} returns a stable {@link FsTarget}; the same underlying file
 *   reached by different input paths must yield the same `targetKey` so stale
 *   guards and file-state lookup agree across paths (e.g. through symlinks).
 * - {@link readPage} returns line-numbered UTF-8 content with a `version` and a
 *   `view` (`full` only when the page covered the whole file).
   * - {@link createOrReplace} honors the {@link FsExpectation}: `observed`
   *   rejects with `FS_STALE_VERSION` if the file changed since `version`;
   *   `partial` rejects existing targets because the owner saw only a
   *   non-editable view; `unobserved` creates iff the target is absent and
   *   otherwise rejects.
 * - {@link applyEdit} verifies the expected version (stale guard) and is atomic
 *   (read-modify-write must not interleave with a concurrent edit).
 */
export abstract class FileSystem extends Service {
  /**
   * Observed-file state, keyed first by the owner object (weakly held, so a
   * collected session frees its state), then by {@link FsTarget.targetKey}.
   */
  private fileStates = new WeakMap<object, Map<string, FileState>>()

  constructor(ctx: Context) {
    super(ctx, 'fs')
    ctx.effect(() => () => {
      // Drop all recorded state on disposal so a reloaded backend starts clean
      // (HMR safety). The WeakMap itself would be GC'd, but replacing it makes
      // the release observable and immediate for tests.
      this.fileStates = new WeakMap()
    }, 'fs file-state teardown')
  }

  // --- Backend primitives (subclass implements; all backend I/O lives here) ---

  /**
   * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May
   * perform I/O (a remote/sandboxed backend may need a round-trip to map a path
   * to a stable identity), hence async even though the local backend only
   * normalizes + realpaths.
   */
  abstract resolve(path: string): Promise<FsTarget>

  /** Read a bounded UTF-8 text page from a target. */
  abstract readPage(target: FsTarget, request: FsReadRequest, signal?: AbortSignal): Promise<FsReadOutcome>

  /**
   * Create or fully replace a UTF-8 text file, honoring `expected` as the
   * stale guard / create-vs-update decision.
   */
  abstract createOrReplace(target: FsTarget, content: string, expected: FsExpectation, signal?: AbortSignal): Promise<FsWriteOutcome>

  /**
   * Apply a literal edit to an existing UTF-8 text file, verifying
   * `expected.version` as the stale guard. Atomic read-modify-write.
   */
  abstract applyEdit(target: FsTarget, edit: FsEditRequest, expected: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>

  // --- Owner + file-state machinery (shared by all backends) ---

  /**
   * Derive the file-state owner from an execution context — normally the active
   * agent session. Returns `undefined` when no owner can be derived (e.g. a
   * direct tool call with no agent); such calls read freely but cannot satisfy
   * the write/edit prior-observation policy.
   */
  owner(exec?: FsExecContext): object | undefined {
    return exec?.agent?.session
  }

  /** Look up recorded state for an owner+target, if any. */
  protected getState(owner: object, targetKey: string): FileState | undefined {
    return this.fileStates.get(owner)?.get(targetKey)
  }

  /** Record (or replace) one owner's observed state for a target. */
  protected recordState(owner: object, state: FileState): void {
    let byTarget = this.fileStates.get(owner)
    if (!byTarget) {
      byTarget = new Map()
      this.fileStates.set(owner, byTarget)
    }
    byTarget.set(state.targetKey, state)
  }

  // --- Concrete public API (orchestration; consumers call these) ---

  /**
   * Read a bounded text page and, when an owner is derivable, record the
   * observed state (a `full` view authorizes later write/edit; a `partial` view
   * does not).
   */
  async read(target: FsTarget, request: FsReadRequest, exec?: FsExecContext, signal?: AbortSignal): Promise<FsReadOutcome> {
    const outcome = await this.readPage(target, request, signal)
    const owner = this.owner(exec)
    if (owner) {
      this.recordState(owner, {
        targetKey: target.targetKey,
        displayPath: target.displayPath,
        version: outcome.version,
        view: outcome.view,
        updatedAt: this.now(),
        source: 'read',
      })
    }
    return outcome
  }

  /**
   * Create or fully replace a file. Updating an existing file requires a `full`
   * prior observation by this owner; a create (no prior state, target absent)
   * does not. After a successful write the recorded state refreshes to `full`
   * at the new version so a follow-up modification needs no re-read.
   */
  async write(target: FsTarget, content: string, exec?: FsExecContext, signal?: AbortSignal): Promise<FsWriteOutcome> {
    const owner = this.owner(exec)
    const prior = owner ? this.getState(owner, target.targetKey) : undefined
    const expected: FsExpectation = prior
      ? prior.view === 'full'
        ? { kind: 'observed', version: prior.version }
        : { kind: 'partial', version: prior.version }
      : { kind: 'unobserved' }

    const outcome = await this.createOrReplace(target, content, expected, signal)
    if (owner) {
      this.recordState(owner, {
        targetKey: target.targetKey,
        displayPath: target.displayPath,
        version: outcome.version,
        view: 'full',
        updatedAt: this.now(),
        source: 'write',
      })
    }
    return outcome
  }

  /**
   * Apply a literal edit. Always requires a `full` prior observation by this
   * owner. No owner or absent state rejects with `FS_NOT_OBSERVED`; a partial
   * view rejects with `FS_PARTIAL_OBSERVATION`; an empty `oldString` rejects
   * before backend I/O. There is no "create via edit". Refreshes recorded
   * state to `full` at the new version on success.
   */
  async edit(target: FsTarget, edit: FsEditRequest, exec?: FsExecContext, signal?: AbortSignal): Promise<FsEditOutcome> {
    if (edit.oldString.length === 0) {
      throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
    }
    const owner = this.owner(exec)
    const prior = owner ? this.getState(owner, target.targetKey) : undefined
    if (!owner || !prior) {
      throw new FsError(`edit requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED')
    }
    if (prior.view !== 'full') {
      throw new FsError(`edit requires a full read of "${target.displayPath}" first`, 'FS_PARTIAL_OBSERVATION')
    }

    const outcome = await this.applyEdit(target, edit, { version: prior.version }, signal)
    this.recordState(owner, {
      targetKey: target.targetKey,
      displayPath: target.displayPath,
      version: outcome.version,
      view: 'full',
      updatedAt: this.now(),
      source: 'edit',
    })
    return outcome
  }

  /**
   * Wall-clock now (ms). A protected seam so tests can use deterministic
   * timestamps; production uses `Date.now()`.
   */
  protected now(): number {
    return Date.now()
  }
}

export default FileSystem
