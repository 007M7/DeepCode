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
 * fresh dead SID's ACEs per restart. A fork gets a new session id and thus a
 * fresh record; the record's workspace must match the session's immutable
 * cwd (asserted by the provider).
 *
 * @module dsh-sandbox-local/acl-session
 */

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * The session's windows-acl write identity was provisioned — log-only
     * (like `sandbox/mode`; NOT a surface event, carries no `surfaceOp`):
     * durable and replayable, never in the model transcript. The LAST such
     * event is the session's record ({@link sessionAclRecord}); the
     * provider appends exactly one on the session's first Windows confined
     * execution.
     */
    'sandbox/acl-session': {
      /** The orphan write SID (`S-1-4-x-y`) whose ACEs form the session's write allowlist. */
      writeSid: string
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
  /** The workspace root the record was provisioned for. */
  workspace: string
  /** The session's private temp subdirectory. */
  tempDir: string
}

/**
 * The session's windows-acl record: the last `sandbox/acl-session` event in
 * the log, or undefined when the session has none (never confined on
 * Windows). The pure fold — resume needs no catch-up machinery because
 * replaying the log IS the state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the last provisioned record, or undefined without one.
 */
export function sessionAclRecord(events: readonly SessionEvent[]): AclSessionRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'sandbox/acl-session') return event.data
  }
  return undefined
}

/**
 * The session's private temp subdirectory: `<tmpdir>\dsh-<first 12 hex of
 * sha256(session id)>`. Deterministic from the session id, so it converges
 * across server restarts (the same SID re-grants the same directory) and OS
 * temp hygiene may reclaim it — deliberately no GC here.
 * @param sessionId - the session identity.
 * @returns the private temp subdirectory path.
 */
export function sessionTempDir(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(tmpdir(), `dsh-${digest}`)
}

/**
 * Provision the record for a session that has none (its first Windows
 * confined execution): a fresh write SID plus the private temp
 * subdirectory, appended as exactly one log-only `sandbox/acl-session`
 * event — the provision IS its event, nothing mutates record state out of
 * band. Fork (new session id) provisions a fresh record; resume replays the
 * stored one.
 * @param session - the session the record belongs to.
 * @param workspaceRoot - the resolved policy root (the session's immutable cwd).
 * @returns the provisioned record.
 */
export function provisionAclSession(session: Session, workspaceRoot: string): AclSessionRecord {
  const record: AclSessionRecord = {
    writeSid: randomWriteSid(),
    workspace: workspaceRoot,
    tempDir: sessionTempDir(session.id),
  }
  session.append('sandbox/acl-session', record)
  return record
}
