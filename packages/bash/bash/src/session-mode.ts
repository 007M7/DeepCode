/**
 * Per-session sandbox-mode override: the session log as the store. A runtime
 * switch (an ACP `session/set_config_option`, a test scenario) is recorded as
 * one `bash/sandbox-mode` event on the session it applies to;
 * `effective = fold(events) ?? the executor's configured default`, so an
 * override survives restart by replay, two sessions can never see each
 * other's state, and there is no external config store. The event is
 * log-only (the `approval/*` precedent): the model receives neither this event
 * nor a standing mode statement. `@deepseek-ai/dsh-tool-bash` names the mode
 * only when it renders a sandbox denial. EXECUTION honors the fold in the tool
 * layer — it stamps the effective mode onto each call's
 * `BashExecRequest.sandboxMode` (weakest-precedence: an escalation grant for
 * the call outranks it) — the executor itself stays a config-fixed default
 * plus per-call overrides.
 *
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
     * override ({@link effectiveSandboxMode}); execution and ACP config-option
     * reporting fold it without adding prompt text or a context notice.
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
 * state out of band. Subsequent execution and ACP config-option reporting fold
 * it on read; no prompt assembly consumes it.
 * @param session - the session the override belongs to.
 * @param mode - the mode every subsequent bash call in this session runs
 *   under (until the next switch).
 */
export function setSandboxMode(session: Session, mode: SandboxMode): void {
  session.append('bash/sandbox-mode', { mode })
}
