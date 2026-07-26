/**
 * Per-session sandbox-mode override: the session log as the store. A runtime
 * switch (a UI policy control or test scenario) is recorded as one
 * `sandbox/mode` event on the session it applies to;
 * `effective = fold(events) ?? the deployment default`, so an override
 * survives restart by replay, two sessions can never see each other's state,
 * and there is no external config store. The event is log-only (the
 * `approval/*` precedent): the model learns the mode from the boundary
 * markers in the enforcing tools, never from the event itself. EXECUTION
 * honors the fold through `ctx.sandboxPolicy.resolve()` — it stamps the mode
 * together with the calling session's workspace root onto each capability
 * call, weakest-precedence beneath an escalation grant.
 *
 * The override is policy state shared by every enforcing family (bash and
 * filesystem alike), so it lives here in the policy package rather than in any
 * one capability's seam.
 *
 * @module dsh-sandbox-policy/session-mode
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
    'sandbox/mode': { mode: SandboxMode }
  }
}

/** Every {@link SandboxMode}, for option advertisement and runtime validation of untrusted mode strings. */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * The session's sandbox-mode override: the last `sandbox/mode` event in the
 * log, or undefined when the session never switched (callers apply the
 * deployment default). The pure fold — resume needs no catch-up machinery
 * because replaying the log IS the state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the mode of the last switch event, or undefined without one.
 */
export function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'sandbox/mode') return event.data.mode
  }
  return undefined
}

/**
 * The session's complete sandbox-mode OVERRIDE chain — the one home every
 * consumer (the policy service, the permission presets) resolves through.
 * With a header baseline (a delegation child), the fold covers only the
 * session's OWN switches past the seed boundary — the baseline was captured
 * from the parent's FULL log at delegation, so any seed-carried switch is
 * already subsumed by it, stale or not. Without a baseline (a top-level
 * session, or a generic `SessionStore.fork` child that captured no policy
 * meta), the fold covers the whole log: seeded switches ARE the replayed
 * inherited truth, and slicing them away would silently widen the child to
 * the deployment default. Never the deployment default itself. The durable
 * baseline is validated UNCONDITIONALLY — a corrupt or foreign header must
 * fail loud on every read, not only when no own switch happens to shadow it.
 * @param session - the session whose override chain to resolve.
 * @returns the effective override, or `undefined` for a session following
 *   the deployment default.
 * @throws when the header baseline is outside the closed mode vocabulary.
 */
export function sandboxOverrideOf(session: Session): SandboxMode | undefined {
  const baseline = session.header.sandboxMode
  if (baseline === undefined) return effectiveSandboxMode(session.events)
  if (!SANDBOX_MODES.includes(baseline as SandboxMode)) {
    throw new Error(`session header sandboxMode "${baseline}" is outside the closed mode vocabulary`)
  }
  const own = effectiveSandboxMode(session.events.slice(session.header.seedLength ?? 0))
  return own ?? baseline as SandboxMode
}

/**
 * THE write path for a session's sandbox-mode override: appends exactly one
 * `sandbox/mode` event — the switch IS its event; nothing mutates mode state
 * out of band. Takes effect on the session's next confined call (bash or fs)
 * — the consumers fold on every read.
 * @param session - the session the override belongs to.
 * @param mode - the mode every subsequent confined call in this session runs
 *   under (until the next switch).
 */
export function setSandboxMode(session: Session, mode: SandboxMode): void {
  session.append('sandbox/mode', { mode })
}
