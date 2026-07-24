/** Process-backed identity helpers for cross-process live-session leases. */

import { randomUUID } from 'node:crypto'

const LIVE_OWNER_ENV = 'DSH_SESSION_LIVE_OWNER'

/** Process identity stored in backend-owned cross-process live-session leases. */
export interface SessionLiveOwner {
  /** Operating-system process id; retained across an `execve` handoff. */
  readonly pid: number
  /** Exec-stable process-start nonce used when the observer has the same PID. */
  readonly nonce: string
}

/** Idempotent capability releasing one acquired live-session lease reference. */
export interface SessionLiveLease {
  /** Release this caller's lease reference after its live session reaches quiescence. */
  release(): Promise<void>
}

/**
 * Stable owner inherited only by an exec-replaced process, not inferred from a session id.
 * @returns this process's PID and exec-stable nonce.
 */
export function sessionLiveOwner(): SessionLiveOwner {
  const nonce = process.env[LIVE_OWNER_ENV] ?? randomUUID()
  process.env[LIVE_OWNER_ENV] = nonce
  return { pid: process.pid, nonce }
}

/**
 * Whether a lease pid still names a process; permission denial counts as live.
 * @param pid - positive operating-system process id from a lease record.
 * @returns true unless the operating system reports that the process is absent.
 */
export function sessionLeaseProcessIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Whether a recorded owner still names this process incarnation or another live PID.
 * A same-PID nonce mismatch proves reuse and is stale; an unrelated live PID is
 * fail-closed because its private nonce is not observable across processes.
 * @param recorded - owner stored in the backend lease.
 * @param observer - identity of the process inspecting or claiming the lease.
 * @returns whether the recorded owner must still be treated as live.
 */
export function sessionLeaseOwnerIsLive(
  recorded: SessionLiveOwner,
  observer: SessionLiveOwner,
): boolean {
  if (recorded.pid === observer.pid) return recorded.nonce === observer.nonce
  return sessionLeaseProcessIsLive(recorded.pid)
}

interface SharedLeaseEntry {
  refs: number
  readonly acquired: Promise<() => Promise<void>>
  finalizing?: Promise<void>
}

const sharedLeases = new Map<string, SharedLeaseEntry>()

/**
 * Reference-count one physical lease across backend instances in this process.
 * @param key - backend-kind plus canonical storage location and session id.
 * @param acquire - single physical acquisition performed for the first reference.
 * @returns an idempotent release for this caller's reference.
 */
export async function shareSessionLiveLease(
  key: string,
  acquire: () => Promise<() => Promise<void>>,
): Promise<() => Promise<void>> {
  for (;;) {
    let entry = sharedLeases.get(key)
    if (entry?.finalizing !== undefined) {
      await entry.finalizing
      continue
    }
    if (entry === undefined) {
      entry = { refs: 0, acquired: acquire() }
      sharedLeases.set(key, entry)
      void entry.acquired.catch(() => {
        /* v8 ignore next -- no public operation can replace a still-acquiring module-private entry */
        if (sharedLeases.get(key) === entry) sharedLeases.delete(key)
      })
    }
    entry.refs += 1
    try {
      await entry.acquired
    } catch (error) {
      entry.refs -= 1
      throw error
    }
    let releaseTask: Promise<void> | undefined
    return () => {
      if (releaseTask !== undefined) return releaseTask
      const task = (async () => {
        entry.refs -= 1
        if (entry.refs > 0 || sharedLeases.get(key) !== entry) return
        const release = await entry.acquired
        await release()
        /* v8 ignore next -- claims wait for finalization before they can replace this exact entry */
        if (sharedLeases.get(key) === entry) sharedLeases.delete(key)
      })()
      const wrapped = task.catch((error: unknown) => {
        entry.refs += 1
        /* v8 ignore next -- this closure is the sole writer of its release state until settlement */
        if (entry.finalizing === wrapped) delete entry.finalizing
        releaseTask = undefined
        throw error
      })
      if (entry.refs === 0 && sharedLeases.get(key) === entry) entry.finalizing = wrapped
      releaseTask = wrapped
      return wrapped
    }
  }
}
