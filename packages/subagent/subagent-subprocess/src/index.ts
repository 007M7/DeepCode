/**
 * Shared machinery for OUT-OF-PROCESS subagent backends — providers that spawn an external
 * agent as a child process and must keep the parent deployment's credentials out of it, tear
 * it down to quiescence, and isolate it from the host user's on-disk CLI state. This package
 * registers no provider; consuming plugins own and validate every timing or path default.
 * @module @deepseek-ai/dsh-subagent-subprocess
 */

import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Credential-shaped ambient env vars are NOT forwarded to a child by default
 * (the parent harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a
 * spawned process implicitly). Same pattern as the bash executor. The child
 * agent needs its OWN credentials to reach a model — those are supplied
 * explicitly via the `extra` layer of {@link buildChildEnv}, which lands AFTER
 * the scrub, so an intended `DEEPSEEK_API_KEY` survives while an incidental
 * `AWS_SECRET_ACCESS_KEY` does not.
 */
const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

/**
 * The ambient env minus credential-shaped vars, plus the caller's explicit
 * env. `PATH`, `HOME`, `TMPDIR`, locale, and proxy vars survive the scrub, so
 * a child CLI runs normally; only credential-shaped names are dropped.
 * @param extra - explicit vars layered on top AFTER the scrub, so a
 * credential-shaped name supplied deliberately still reaches the child.
 * @returns the environment to spawn the child with.
 */
export function buildChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_PATTERN.test(key)) env[key] = value
  }
  return { ...env, ...extra }
}

/**
 * Capture the child's spawn-level `error` event as a promise. Call in the same tick as
 * `spawn()`; otherwise an early event can be unhandled and crash the parent.
 * @param child - the just-spawned child process.
 * @returns a promise that RESOLVES (never rejects) with the child's first
 * `error` event; for a child that spawns cleanly it never settles.
 */
export function spawnFailure(child: ChildProcess): Promise<Error> {
  return new Promise<Error>((resolve) => {
    child.once('error', (err) => { resolve(err) })
  })
}

/**
 * Race the child's exit against a timer. Neither outcome leaves anything
 * behind on the child: the exit listener is removed on timeout and the timer
 * is cleared on exit, so repeated calls (the dispose ladder's tiers, a poll
 * loop) never accumulate listeners.
 * @param child - the child process to watch.
 * @param ms - the wait window in milliseconds.
 * @returns `true` if the child exits within `ms` (immediately if it is
 * already gone), `false` on timeout.
 */
function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    // `.unref()` so a pending grace timer never keeps the parent's loop alive.
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, ms).unref()
    child.once('exit', onExit)
  })
}

/**
 * The two grace periods of the dispose ladder, supplied per call by the
 * consuming backend — each plugin carries them as defaulted, validated
 * `disposeEofGraceMs`/`disposeGraceMs` Config fields, so teardown timing is
 * deployment-tunable and this library hardcodes nothing.
 */
export interface DisposeLadderGraces {
  /**
   * Tier-1 window (ms): after stdin EOF, how long the child gets to quiesce
   * ON ITS OWN — flush durable state, tear down its own nested subprocesses —
   * before the parent escalates to platform termination. A separate (usually WIDER)
   * grace than {@link DisposeLadderGraces.disposeGraceMs}: a cooperative
   * child's EOF-driven teardown may itself be waiting on a signal-trapping
   * grandchild plus a final flush, needing more than one signal-grace of
   * headroom.
   */
  disposeEofGraceMs: number
  /**
   * Termination confirmation window (ms): POSIX applies it after `SIGTERM` and again after
   * `SIGKILL`; Windows applies it after the direct forced termination.
   */
  disposeGraceMs: number
}

/** Force-terminate a child and reject if no exit edge arrives within the configured grace. */
function forceTerminateWithin(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let accepted = false
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      complete()
    }
    const onExit = (): void => { settle(resolve) }
    const onError = (error: Error): void => { settle(() => { reject(error) }) }
    child.once('exit', onExit)
    child.once('error', onError)
    const timer = setTimeout(() => {
      const disposition = accepted ? 'accepted' : 'refused'
      settle(() => {
        reject(new Error(`child process did not exit within ${ms}ms after SIGKILL was ${disposition}`))
      })
    }, ms).unref()
    try {
      accepted = child.kill('SIGKILL')
      if (child.exitCode !== null || child.signalCode !== null) settle(resolve)
    } catch (error: unknown) {
      settle(() => { reject(new Error('SIGKILL failed', { cause: error })) })
    }
  })
}

/**
 * Tear a child process down to quiescence, resolving only after exit: close stdin and allow
 * cooperative flush, then use the host's graceful and forced termination semantics. POSIX
 * sends `SIGTERM` before `SIGKILL`; Windows skips directly to forced termination because Node
 * maps both signals to `TerminateProcess`.
 *
 * @param child - the child process to tear down.
 * @param graces - the two grace periods, from the consuming plugin's Config.
 * @param platform - the host platform, injectable for unit coverage.
 * @throws When forced termination errors or the child does not report exit within
 * `disposeGraceMs`.
 */
export async function disposeChildProcess(
  child: ChildProcess,
  graces: DisposeLadderGraces,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // Already gone: nothing to reap.
  if (child.exitCode !== null || child.signalCode !== null) return
  // 1. Close stdin and allow cooperative teardown and durable-state flush.
  child.stdin?.end()
  if (await exitsWithin(child, graces.disposeEofGraceMs)) return
  // 2. POSIX gets a catchable graceful signal; Windows signals all force-terminate.
  if (platform !== 'win32') {
    child.kill('SIGTERM')
    if (await exitsWithin(child, graces.disposeGraceMs)) return
  }
  // 3. Force-kill and await a bounded exit edge.
  await forceTerminateWithin(child, graces.disposeGraceMs)
}

/**
 * A per-run config directory handle for an external CLI child — the target of
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME`-style redirection. Hand {@link path} to
 * the child's environment; call {@link remove} on dispose.
 */
export interface IsolatedConfigDir {
  /** The directory to point the child at. */
  path: string
  /**
   * Best-effort cleanup: removes the directory (recursively) iff this handle
   * CREATED it — a pinned directory is never removed. Idempotent; never
   * rejects (a leftover dir under the OS temp root is preferable to a failed
   * dispose).
   */
  remove(): Promise<void>
}

/**
 * An isolated config dir for one child run, independent of host CLI state. Without
 * `pinnedPath`, creates a private temp directory and removes it best-effort; a pinned directory
 * is returned unchanged and remains deployment-owned.
 *
 * @param prefix - the `mkdtemp` name prefix for a fresh dir (e.g.
 * `dsh-subagent-codex-`); ignored when `pinnedPath` is set.
 * @param pinnedPath - a deployment-pinned directory to use instead of a
 * fresh one.
 * @returns the directory handle: `path` for the child env, `remove()` for
 * dispose.
 */
export async function createIsolatedConfigDir(prefix: string, pinnedPath?: string): Promise<IsolatedConfigDir> {
  if (pinnedPath !== undefined) {
    return {
      path: pinnedPath,
      remove(): Promise<void> {
        // A pinned dir is deployment-owned state (config the user asked to
        // persist across runs); removing it here would destroy it. No-op.
        return Promise.resolve()
      },
    }
  }
  const path = await mkdtemp(join(tmpdir(), prefix))
  return {
    path,
    async remove(): Promise<void> {
      try {
        await rm(path, { recursive: true, force: true })
      } catch {
        // Best-effort by contract: swallows rm failures (EACCES/EBUSY-style — e.g. the dead
        // child left an unreadable entry behind).
      }
    },
  }
}
