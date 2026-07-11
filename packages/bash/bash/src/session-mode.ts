/**
 * Per-session sandbox-mode override: the session log as the store.
 * @module dsh-bash/session-mode
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * The session's sandbox mode was switched — log-only (like `approval/*`;
     * NOT a surface event, carries no `surfaceOp`): durable and replayable,
     * never in the model transcript. The LAST such event is the session's
     * override ({@link effectiveSandboxMode}); who asked for it is derivable
     * from position (an event after the log's last `request/header*` was a
     * runtime switch by the user; see the tool layer's narrator).
     */
    'bash/sandbox-mode': { mode: SandboxMode }
  }
}

/** Every {@link SandboxMode}, for option advertisement and runtime validation of untrusted mode strings. */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * The session's sandbox-mode override: the last `bash/sandbox-mode` event in
 * the log, or undefined when the session never switched (callers apply the
 * executor's configured default). The pure fold — resume needs no catch-up
 * machinery because replaying the log IS the state.
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
 * THE write path for a session's sandbox-mode override: appends exactly one
 * `bash/sandbox-mode` event — the switch IS its event; nothing mutates mode
 * state out of band. Takes effect on the session's next bash call and next
 * prompt assembly (the consumers fold on every read).
 * @param session - the session the override belongs to.
 * @param mode - the mode every subsequent bash call in this session runs
 *   under (until the next switch).
 */
export function setSandboxMode(session: Session, mode: SandboxMode): void {
  session.append('bash/sandbox-mode', { mode })
}
