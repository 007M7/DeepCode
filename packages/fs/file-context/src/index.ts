/**
 * The file-context policy PLUGIN: observed-state, read-before-edit, and
 * "write/edit must be based on the version you read" — added on top of the
 * `ctx.fs` provider seam through the `fs/*` event gate, NOT through a method
 * service. This plugin registers NO `ctx.fileContext` service and exposes no
 * `read`/`write`/`edit`/`resolve` methods; it influences the world only by
 * deciding the `fs/write-expectation`/`fs/edit-expectation` waterfalls and
 * recording on `fs/observed`. That is what keeps `@deepseek-ai/dsh-tool-fs`
 * (the executor) free of any method coupling to the policy layer — removing
 * this plugin gracefully loses the policy and leaves the unconstrained bare
 * provider, rather than breaking the tool at a service-injection boundary.
 *
 * ## Observed state IS the prior-observation record
 *
 * State lives here as `WeakMap<owner, Map<targetKey, { version }>>`. An entry
 * exists iff the owner has read, written, OR edited that target (every success
 * emits `fs/observed`), so its presence means "this owner has observed this
 * target at this version". This is what lets a create-then-edit or
 * edit-then-edit sequence work without an intervening re-read: the mutation
 * refreshes the recorded version to its own result. The owner is derived
 * structurally from `{ agent?: { session? } }` and held weakly, so a collected
 * session frees its state; disposal drops everything (HMR safety).
 *
 * ## Freshness via provider CAS, not stat
 *
 * This plugin does NO filesystem I/O. "Have you observed this file?" is a
 * `WeakMap` lookup (no record ⇒ `FS_NOT_OBSERVED`). "Is the version you read
 * still current?" is decided INSIDE `ctx.fs.editText`/`writeText`, in the same
 * atomic lock that performs the mutation — this plugin only supplies the
 * observed version as the CAS basis. Stat-ing and comparing here would open a
 * TOCTOU gap the provider lock has to back up anyway, so it is deliberately
 * avoided.
 *
 * ## Single-slot, first-wins
 *
 * The `fs/write-expectation`/`fs/edit-expectation` listeners do NOT call
 * `next()`: each fully decides its single slot. The slot is first-wins by
 * registration order — this plugin owning it is the default-deployment
 * convention, not an event-enforced invariant (a decider registered before /
 * `prepend`ed would win instead). This is not a composable authorization chain;
 * layered permission/audit/sandbox interception belongs on `tools/execute`.
 *
 * @module @deepseek-ai/dsh-file-context
 */

import type { Context } from 'cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion, FsWriteExpectation } from '@deepseek-ai/dsh-fs'
import type { FileContextExec } from './types.ts'

export type { FileContextExec } from './types.ts'

/**
 * Per-context observed-file state and the three `fs/*` decisions over it. One
 * instance is created per `apply()` so disposal can drop all state for HMR.
 */
class ObservedStateGate {
  /**
   * Observed-file state, keyed first by the owner object (weakly held, so a
   * collected session frees its state), then by {@link FsTarget.targetKey}. An
   * entry's PRESENCE is the prior-observation record.
   */
  private observed = new WeakMap<object, Map<string, FsVersion>>()

  /**
   * Derive the observed-state owner from the opaque event actor — normally the
   * active agent session. `undefined` when no owner can be derived (e.g. a
   * direct tool call with no agent); such calls read freely but cannot satisfy
   * the write/edit prior-observation policy.
   */
  private owner(actor: object | undefined): object | undefined {
    return (actor as FileContextExec | undefined)?.agent?.session
  }

  private get(owner: object, targetKey: string): FsVersion | undefined {
    return this.observed.get(owner)?.get(targetKey)
  }

  private set(owner: object, targetKey: string, version: FsVersion): void {
    let byTarget = this.observed.get(owner)
    if (!byTarget) {
      byTarget = new Map()
      this.observed.set(owner, byTarget)
    }
    byTarget.set(targetKey, version)
  }

  /** Drop all recorded state (HMR safety / disposal). */
  clear(): void {
    this.observed = new WeakMap()
  }

  /**
   * Decide the write expectation: no prior observation ⇒ `createIfAbsent` (only
   * new files can be created blindly); a prior observation ⇒ `replaceIfVersion`
   * at the observed version (existing files replaced only if unchanged).
   */
  writeExpectation(target: FsTarget, actor: object | undefined): FsWriteExpectation {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    return prior ? { kind: 'replaceIfVersion', version: prior } : { kind: 'createIfAbsent' }
  }

  /**
   * Decide the edit version guard: requires a prior observation by this owner
   * (else `FS_NOT_OBSERVED`); returns the observed version as the CAS basis.
   */
  editExpectation(target: FsTarget, actor: object | undefined): { version: FsVersion } {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    if (!owner || !prior) {
      throw new FsError(`edit requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED')
    }
    return { version: prior }
  }

  /** Record a successful read/write/edit: this owner observed this target at this version. */
  observe(target: FsTarget, version: FsVersion, actor: object | undefined): void {
    const owner = this.owner(actor)
    if (owner) this.set(owner, target.targetKey, version)
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'file-context'

/**
 * Register the three `fs/*` listeners. No `inject` — this plugin reads no
 * services; it operates only on its own `WeakMap`. The waterfalls are unbound
 * (the tool dispatches them with no `this`), so the listeners take the raw
 * `(target, actor, next)` arguments.
 */
export function apply(ctx: Context): void {
  const gate = new ObservedStateGate()

  ctx.effect(() => () => {
    // Drop all recorded state on disposal so a reloaded plugin starts clean
    // (HMR safety). The WeakMap itself would be GC'd, but replacing it makes the
    // release observable and immediate for tests.
    gate.clear()
  }, 'file-context observed-state teardown')

  // fs/write-expectation: occupy the single decision slot — do NOT call next().
  // Deferred through Promise.resolve().then so the declared Promise return type
  // holds (a throw rejects, never escapes synchronously through the waterfall).
  ctx.on('fs/write-expectation', (target, actor) => Promise.resolve().then(() => gate.writeExpectation(target, actor)))

  // fs/edit-expectation: occupy the single decision slot — do NOT call next().
  // Deferred the same way so an FS_NOT_OBSERVED throw becomes a rejected promise
  // the edit tool's `await ctx.waterfall(...)` surfaces as its isError result.
  ctx.on('fs/edit-expectation', (target, actor) => Promise.resolve().then(() => gate.editExpectation(target, actor)))

  // fs/observed: synchronous, side-effect-only WeakMap write (cannot throw under
  // normal operation); the tool contains any throw so a record bug never fails
  // the already-completed mutation.
  ctx.on('fs/observed', (target, version, actor) => {
    gate.observe(target, version, actor)
  })
}
