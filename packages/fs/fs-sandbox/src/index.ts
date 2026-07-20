/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@deepseek-ai/dsh-fs` provider seam. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section — are the local
 * implementation's, verbatim; this package adds only the per-call MODE fence
 * on the two mutations. Reads pass through untouched: every mode permits
 * reading.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
 * and only the target path is untrusted, so canonicalize-then-contain is the
 * complete answer to this surface. Kernel-grade isolation of untrusted CODE
 * stays `ctx.bash`'s job (`@deepseek-ai/dsh-bash-sandbox`). This mirrors the
 * `code-runtime` stance: containment, not a security boundary. The residual
 * TOCTOU (an ancestor symlink swapped between the containment re-check and the
 * syscall) is narrowed by re-canonicalizing immediately before delegating and
 * is accepted for this threat model.
 *
 * Per-call mode: `read-only` denies every mutation; `workspace-write` allows a
 * mutation only when the target canonicalizes under the workspace root or a
 * platform temp area (the SAME writable-root set the Seatbelt profile grants,
 * derived from the one `writableRoots` function so bash and fs cannot drift);
 * `danger-full-access` delegates unfenced. A denial throws the structured
 * `FS_SANDBOX_DENIED` — no text inference is needed (unlike bash's kernel
 * stderr), because an in-process fence knows exactly what it refused. The
 * escalation retry lives in the tool layer (`@deepseek-ai/dsh-tool-fs`),
 * exactly as bash's does.
 *
 * @module @deepseek-ai/dsh-fs-sandbox
 */

import { sep } from 'node:path'
import { Context } from 'cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/**
 * Plugin config: the local backend's knobs, verbatim (only `cwd`, the resolve
 * base for relative paths). The sandbox default (mode + `workspace-write`
 * boundary root) is NOT here — it lives on `ctx.sandboxPolicy`, the one home
 * both enforcing families share.
 */
export type Config = LocalConfig

/** Whether `path` is `root` itself or lies beneath it (both already canonical). */
function isUnder(path: string, root: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the fallback exposed by {@link sandboxMode}; `dsh-tool-fs` folds a session's
 * `sandbox/mode` override and stamps the effective mode onto each mutation,
 * while an approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']

  private readonly defaultMode: SandboxMode
  /**
   * The canonical roots a `workspace-write` mutation may land under, computed
   * once (the workspace root and platform temp areas are fixed for the
   * provider's lifetime): the same set {@link writableRoots} gives every
   * enforcement dialect, so the fs fence and the bash runner agree.
   */
  private readonly writableRoots: string[]

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
    this.writableRoots = writableRoots({ mode: 'workspace-write', workspaceRoot: ctx.sandboxPolicy.workspaceRoot })
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the write by the per-call mode, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before the atomic rename takes effect.
   * @param sandboxMode - the per-call mode; omit to use the deployment default.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxMode?: SandboxMode,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxMode), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call mode, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before the atomic rename takes effect.
   * @param sandboxMode - the per-call mode; omit to use the deployment default.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxMode?: SandboxMode,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxMode), edit, expected, signal)
  }

  /**
   * Enforce the per-call mode against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, and returns THAT fresh target; `danger-full-access` returns
   * the caller's target unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint.
   */
  private async checkedTarget(target: FsTarget, sandboxMode?: SandboxMode): Promise<FsTarget> {
    const mode = sandboxMode ?? this.defaultMode
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.resolve(target.displayPath)
    if (!this.writableRoots.some(root => isUnder(fresh.targetKey, root))) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }
}

export default SandboxedFileSystem
