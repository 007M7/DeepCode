/**
 * The windows-acl per-session write identity — the DURABLE half of the seam's
 * per-session grant reuse. Each session owns exactly one record (one orphan
 * write SID, one private temp subdirectory), stored as a log-only
 * `sandbox/acl-session` event on the session log (the `sandbox/mode`
 * precedent): replayable, never in the model transcript, and no external
 * config store. The ACE half is server-lifetime state owned by the provider
 * ({@link AclWriteGrant} materialization, revoked on dispose); the record
 * survives restarts so a resumed session reuses the SAME SID — re-granting
 * idempotently merges into (or skips) the standing ACEs instead of leaking a
 * fresh dead SID's ACEs per restart. The record is BOUND to its owning
 * session id, so a fork (which copies the parent's events, record included)
 * never inherits the parent's identity — it provisions a fresh one. The
 * record's payload is durable input and is validated at the fold (orphan-SID
 * shape, well-formed temp path); a matching-but-tampered record fails loud.
 *
 * @module dsh-sandbox-local/acl-session
 */

import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * The session's windows-acl write identity was provisioned — log-only
     * (like `sandbox/mode`; NOT a surface event, carries no `surfaceOp`):
     * durable and replayable, never in the model transcript. The LAST such
     * event owned by the session is its record ({@link sessionAclRecord});
     * the provider appends exactly one on the session's first Windows
     * confined execution.
     */
    'sandbox/acl-session': {
      /** The orphan write SID (`S-1-4-x-y`) whose ACEs form the session's write allowlist. */
      writeSid: string
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
  /** The orphan write SID whose ACEs form the session's write allowlist. */
  writeSid: string
  /** The owning session id (binds the record against fork inheritance). */
  sessionId: SessionId
  /** The workspace root the record was provisioned for. */
  workspace: string
  /** The session's private temp subdirectory. */
  tempDir: string
}

/** Orphan shape `S-1-4-x-y` — a replayed `Everyone` SID would widen the grant to every token. */
const ORPHAN_SID_PATTERN = /^S-1-4-\d+-\d+$/u

/**
 * The session's record: the last `sandbox/acl-session` event owned by it, or
 * undefined (never confined / a fork). Durable-input validation: tampered
 * SID or temp path fails loud. @param events/@param sessionId/@returns as
 * below.
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
    if (typeof data.writeSid !== 'string' || !ORPHAN_SID_PATTERN.test(data.writeSid)) {
      throw new Error(
        `sandbox-local: session "${sessionId}" acl record carries a malformed write SID ${JSON.stringify(data.writeSid)} `
        + '(expected the orphan shape S-1-4-x-y)',
      )
    }
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
 * confined execution): a fresh write SID plus the private temp subdirectory,
 * appended as exactly one log-only `sandbox/acl-session` event — the
 * provision IS its event, nothing mutates record state out of band. Fork
 * (whose copied parent record is not its own) provisions a fresh record;
 * resume replays the stored one.
 * @param session - the session the record belongs to.
 * @param workspaceRoot - the resolved policy root (the session's immutable cwd).
 * @returns the provisioned record.
 */
export function provisionAclSession(session: Session, workspaceRoot: string): AclSessionRecord {
  const record: AclSessionRecord = {
    writeSid: randomWriteSid(),
    sessionId: session.id,
    workspace: workspaceRoot,
    tempDir: sessionTempDir(),
  }
  session.append('sandbox/acl-session', record)
  return record
}
