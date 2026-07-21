/** Model and ACP rendering for persistent terminal tool results. */

import type { PtyReadResult, PtySendRead, PtySendResult, PtySessionSnapshot, PtySpawnResult } from '@deepseek-ai/dsh-pty'

/**
 * Render one created session and its bounded MOTD.
 * @param result - published spawn result.
 * @returns Model-facing session acknowledgement.
 */
export function renderSpawn(result: PtySpawnResult): string {
  const label = result.name === undefined ? result.sessionId : `${result.sessionId} (${result.name})`
  return `started terminal session ${label} [type: ${result.type}]\n${result.motd || '(no startup output)'}`
}

/**
 * Render one settled interactive send.
 * @param result - settled send outcome.
 * @returns Terminal output plus wait/session markers.
 */
export function renderSend(result: PtySendResult): string {
  const output = result.viewport || '(no new output)'
  const status = result.sessionStatus.kind === 'running'
    ? 'running'
    : `exited code=${result.sessionStatus.exitCode ?? 'null'} signal=${result.sessionStatus.signal ?? 'null'}`
  return `${output}\n[wait: ${result.waitReason}]\n[session: ${status}]${result.truncated ? '\n[output truncated]' : ''}`
}

/**
 * Render one incremental background operation read.
 * @param read - consuming operation delta.
 * @returns Delta plus truncation marker when needed.
 */
export function renderSendRead(read: PtySendRead): string {
  return `${read.delta}${read.truncated ? `${read.delta.endsWith('\n') || read.delta.length === 0 ? '' : '\n'}[output truncated]` : ''}`
}

/**
 * Render one bounded historical page.
 * @param result - retained scrollback page.
 * @returns Page text plus pagination and truncation markers.
 */
export function renderRead(result: PtyReadResult): string {
  const output = result.text || '(no retained output)'
  return `${output}\n[lines: ${result.lineBegin}-${result.lineEnd} of ${result.totalLines}]${result.truncated ? '\n[output truncated]' : ''}`
}

/**
 * Render owner-visible live sessions.
 * @param sessions - fresh owner-scoped snapshots.
 * @returns One line per session or the empty marker.
 */
export function renderList(sessions: PtySessionSnapshot[]): string {
  if (sessions.length === 0) return '(no terminal sessions)'
  return sessions.map((session) => {
    const name = session.name === undefined ? '' : ` (${session.name})`
    const pid = session.pid === undefined ? '' : ` pid=${session.pid}`
    const status = session.status.kind === 'running'
      ? 'running'
      : `exited code=${session.status.exitCode ?? 'null'} signal=${session.status.signal ?? 'null'}`
    return `${session.sessionId}${name} [${session.type}] ${status}${pid}`
  }).join('\n')
}
