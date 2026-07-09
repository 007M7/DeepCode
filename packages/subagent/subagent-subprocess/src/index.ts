/**
 * Shared machinery for OUT-OF-PROCESS subagent backends — providers that spawn
 * an external agent as a child process and must keep the parent deployment's
 * credentials out of it, tear it down to quiescence, and isolate it from the
 * host user's on-disk CLI state. The pieces: the credential env scrub
 * ({@link SENSITIVE_ENV_PATTERN} / {@link buildChildEnv}), the spawn-failure
 * capture ({@link spawnFailure}), the child-exit waits ({@link waitForExit} /
 * {@link exitsWithin}), the stdin-EOF → SIGTERM → SIGKILL dispose ladder
 * ({@link disposeChildProcess}), and the per-run isolated config dir
 * ({@link createIsolatedConfigDir}).
 *
 * This package owns no provider and registers nothing; it is a pure library
 * the out-of-process backend packages depend on (the `subagent-inprocess`
 * shape, for the process boundary). Every tunable — the ladder's grace
 * periods, a pinned config dir — is a PARAMETER here: defaults belong in each
 * consuming plugin's Config, per the no-hardcoded-tunables rule.
 *
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
export const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

/**
 * The ambient env minus credential-shaped vars, plus the caller's explicit
 * env. `PATH`, `HOME`, `TMPDIR`, locale, and proxy vars survive the scrub, so
 * a child CLI runs normally; only {@link SENSITIVE_ENV_PATTERN}-shaped names
 * are dropped.
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
 * Capture the child's spawn-level failure as a promise the run's result path
 * can race. A spawn failure (e.g. `ENOENT` for a bad command) is emitted as an
 * `error` EVENT, not a thrown exception — and without a listener Node treats
 * it as an unhandled error and crashes the parent process. Call this in the
 * SAME TICK as `spawn()`, so no window exists for the event to fire unheard.
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
 * Resolve once the child process exits (any code/signal); immediate if it is
 * already gone.
 * @param child - the child process to await.
 */
export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolve => child.once('exit', () => { resolve() }))
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
export function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
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
   * before the parent escalates to `SIGTERM`. A separate (usually WIDER)
   * grace than {@link DisposeLadderGraces.disposeGraceMs}: a cooperative
   * child's EOF-driven teardown may itself be waiting on a signal-trapping
   * grandchild plus a final flush, needing more than one signal-grace of
   * headroom.
   */
  disposeEofGraceMs: number
  /** Tier-2 window (ms): between `SIGTERM` and the `SIGKILL` escalation. */
  disposeGraceMs: number
}

/**
 * Tear a child process down to QUIESCENCE: resolves only once the child has
 * actually exited (or was already gone), never merely after requesting it.
 * Three-tier escalation —
 *
 * 1. stdin EOF (when stdin is piped), then wait `disposeEofGraceMs`: a
 *    cooperative child quiesces on its own, its teardown and flushes intact;
 * 2. `SIGTERM`, then wait `disposeGraceMs`;
 * 3. `SIGKILL`, then await the (now-certain) exit — a child that ignores EOF
 *    and traps `SIGTERM` must not wedge dispose forever.
 *
 * @param child - the child process to tear down.
 * @param graces - the two grace periods, from the consuming plugin's Config.
 */
export async function disposeChildProcess(child: ChildProcess, graces: DisposeLadderGraces): Promise<void> {
  // Already gone: nothing to reap.
  if (child.exitCode !== null || child.signalCode !== null) return
  // 1. Graceful: end the request stream (stdin EOF) and let the child quiesce
  //    on its own. Sending SIGTERM in the same tick (or too soon) would
  //    default-terminate a cooperative child mid-flush, orphaning its nested
  //    work. A child spawned without a stdin pipe skips straight to the wait.
  child.stdin?.end()
  if (await exitsWithin(child, graces.disposeEofGraceMs)) return
  // 2. SIGTERM, escalating if the child still does not exit within the grace.
  child.kill('SIGTERM')
  if (await exitsWithin(child, graces.disposeGraceMs)) return
  // 3. Force-kill and await the (now-certain) exit.
  child.kill('SIGKILL')
  await waitForExit(child)
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
 * An isolated config dir for one child run, so the child's behavior is a
 * function of deployment config alone — never of whatever `~/.claude` /
 * `~/.codex`-style state happens to exist on the host machine. Two modes:
 *
 * - no `pinnedPath` (the default): creates a FRESH private (0700) `mkdtemp`
 *   dir under the OS temp root; {@link IsolatedConfigDir.remove} deletes it
 *   best-effort;
 * - `pinnedPath` set (a deployment deliberately sharing state across runs):
 *   the pinned path is returned as-is — never created, never removed — the
 *   deployment owns that directory's lifecycle.
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
        // Best-effort by contract: swallows rm failures (EACCES/EBUSY-style —
        // e.g. the dead child left an unreadable entry behind). The dir lives
        // under the OS temp root, which reclaims it; failing dispose over
        // cleanup would be worse than a leftover temp dir.
      }
    },
  }
}
