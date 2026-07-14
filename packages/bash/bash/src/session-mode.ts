/**
 * Per-session sandbox-mode override stored as log-only events. Folding the log
 * isolates sessions and survives replay; the tool stamps the override onto
 * each call unless an approved one-shot escalation outranks it, and the
 * executor default applies when neither exists. The model receives neither the
 * event nor a standing-mode notice; denial results name the effective mode.
 * @module dsh-bash/session-mode
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Durable log-only sandbox-mode override; never a surface event or model
     * message. Execution and ACP option reporting fold the latest event through
     * {@link effectiveSandboxMode} without adding a prompt notice.
     */
    'bash/sandbox-mode': { mode: SandboxMode }
  }
}

/** Every {@link SandboxMode}, for option advertisement and runtime validation of untrusted mode strings. */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * The session's sandbox-mode override: the last `bash/sandbox-mode` event in
 * the log, or undefined when the session never switched and callers should use
 * the executor default. Replay needs no separate catch-up state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the mode of the last switch event, or undefined without one.
 */
export function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'bash/sandbox-mode') return event.data.mode
  }
  return undefined
}

/**
 * Append one `bash/sandbox-mode` event as the only override write path.
 * Execution and ACP option reporting fold it on read; prompt assembly does not
 * consume it.
 * @param session - the session the override belongs to.
 * @param mode - the mode every subsequent bash call in this session runs
 *   under (until the next switch).
 */
export function setSandboxMode(session: Session, mode: SandboxMode): void {
  session.append('bash/sandbox-mode', { mode })
}
