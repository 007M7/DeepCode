/**
 * The windows-acl session write record — the DURABLE half of the seam's
 * grant lifecycle. Each session owns exactly one record (its workspace
 * binding plus one private temp subdirectory), stored as a log-only
 * `sandbox/acl-session` event on the session log (the `sandbox/mode`
 * precedent): replayable, never in the model transcript, and no external
 * config store. The record carries NO SID: the write SID is the
 * per-WORKSPACE identity derived from the workspace path
 * (`workspaceWriteSid`) — deterministic across sessions and server
 * restarts, so the workspace-root ACE materializes once per workspace per
 * machine (the grant's exact-ACE skip makes every later provision O(1))
 * instead of once per session. The ACE half is server-lifetime state owned
 * by the provider ({@link AclWriteGrant}: workspace ACEs standing, temp ACEs
 * revocable); the record survives restarts so a resumed session reuses the
 * SAME private temp subdirectory and the same derived SID — re-granting
 * idempotently merges into (or skips) the standing ACEs. The record is
 * BOUND to its owning session id, so a fork (which copies the parent's
 * events, record included) never inherits the parent's temp identity — it
 * provisions a fresh one. The record's payload is durable input and is
 * validated at the fold (well-formed workspace/temp paths); a
 * matching-but-tampered record fails loud.
 *
 * @module dsh-sandbox-local/acl-session
 */

import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's windows-acl write record was provisioned — log-only
     * (like `sandbox/mode`; NOT a surface event, carries no `surfaceOp`):
     * durable and replayable, never in the model transcript. The LAST such
     * event owned by the session is its record ({@link sessionAclRecord});
     * the provider appends exactly one on the session's first Windows
     * confined execution. The write SID itself is NOT stored — it is the
     * per-workspace identity derived from `workspace`
     * (`workspaceWriteSid`).
     */
    'sandbox/acl-session': {
      /** The owning session — the binding a fork's copied event cannot satisfy. */
      sessionId: SessionId
      /** The workspace root the grant applies to (the session's immutable cwd, as resolved). */
      workspace: string
      /** The session's private temp subdirectory under the host temp root. */
      tempDir: string
    }
  }
}

/** The durable per-session record carried by one `sandbox/acl-session` event. */
export interface AclSessionRecord {
  /** The owning session id (binds the record against fork inheritance). */
  sessionId: SessionId
  /** The workspace root the record was provisioned for (the write SID derives from it). */
  workspace: string
  /** The session's private temp subdirectory. */
  tempDir: string
}

/**
 * The session's record: the last `sandbox/acl-session` event owned by it, or
 * undefined (never confined / a fork). Durable-input validation: tampered
 * workspace or temp path fails loud. @param events/@param sessionId/@returns
 * as below.
 * @param events - session events (other types skipped).
 * @param sessionId - owning session (fork binding).
 * @returns the last owned record, or undefined without one.
 */
export function sessionAclRecord(events: readonly SessionEvent[], sessionId: SessionId): AclSessionRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type !== 'sandbox/acl-session') continue
    const data = event.data
    // Fork copies the parent's record: skip non-owned records (fork mints fresh).
    if (data.sessionId !== sessionId) continue
    if (typeof data.workspace !== 'string' || data.workspace.length === 0) {
      throw new Error(`sandbox-local: session "${sessionId}" acl record carries an empty workspace`)
    }
    if (typeof data.tempDir !== 'string' || dirname(data.tempDir) !== tmpdir()) {
      throw new Error(
        `sandbox-local: session "${sessionId}" acl record carries a temp path outside the host temp root: ${JSON.stringify(data.tempDir)}`,
      )
    }
    return data
  }
  return undefined
}

/**
 * The session's private temp subdirectory name: `<tmpdir>\dsh-<16 random hex>`.
 * The name is RANDOM and persisted in the record — convergence across server
 * restarts comes from the record (the same SID re-grants the same directory),
 * not from any derivation an attacker (who knows the session id through
 * `DSH_SESSION_ID`) could predict and pre-place. The provider creates it
 * exclusively and rejects reparse points; OS temp hygiene may reclaim it —
 * deliberately no GC here.
 * @returns the private temp subdirectory path.
 */
export function sessionTempDir(): string {
  return join(tmpdir(), `dsh-${randomBytes(8).toString('hex')}`)
}

/**
 * Provision the record for a session that has none (its first Windows
 * confined execution): the workspace binding plus the private temp
 * subdirectory, appended as exactly one log-only `sandbox/acl-session`
 * event — the provision IS its event, nothing mutates record state out of
 * band. Fork (whose copied parent record is not its own) provisions a fresh
 * record; resume replays the stored one.
 * @param session - the session the record belongs to.
 * @param workspaceRoot - the resolved policy root (the session's immutable cwd).
 * @returns the provisioned record.
 */
export function provisionAclSession(session: Session, workspaceRoot: string): AclSessionRecord {
  const record: AclSessionRecord = {
    sessionId: session.id,
    workspace: workspaceRoot,
    tempDir: sessionTempDir(),
  }
  session.append('sandbox/acl-session', record)
  return record
}
