/**
 * Approval seam: `ctx.approval` answers exactly one question — "may this
 * specific action proceed?" — by dispatching the `approval/request` waterfall
 * to whatever answerers the deployment composed (an ACP editor prompt, an
 * auto-decide policy, a scripted test listener) and returning a closed
 * {@link ApprovalOutcome}. With no answerer the waterfall falls through to the
 * built-in default `'unavailable'`: absence of a UI can never grant anything.
 *
 * The service is the MECHANISM (dispatch, cancellation, audit); answerers are
 * the POLICY. It serves both ask paths the sandbox RFC names — the
 * `tools/pre-execute` `ask` decision today, and the sandbox post-denial
 * escalation when that phase lands — so every asker shares one outcome
 * vocabulary and one audit trail. Grants are one-shot by design: an
 * `'allowed-once'` outcome authorizes the single action it was asked about,
 * never a class of future actions.
 *
 * Every request lands two log-only session events on the requesting agent's
 * log (`approval/asked` / `approval/decided`, paired by
 * {@link ApprovalRequestId}) — an audit trail, deliberately NOT part of the
 * model-visible transcript: the model only ever sees the tool result the
 * caller derives from the outcome.
 *
 * @module @deepseek-ai/dsh-approval
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from 'cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'

declare module 'cordis' {
  interface Context {
    approval: ApprovalService
  }

  interface Events {
    /**
     * Waterfall asking the composed answerers to decide one approval request.
     * Dispatched only from {@link ApprovalService.request} — callers go through
     * the service (which owns cancellation and the audit events), never through
     * `ctx.waterfall` directly. A listener that can answer for this request's
     * agent returns an outcome WITHOUT calling `next()` (the decision slot is
     * single-occupancy, first listener to answer wins); a listener that does
     * not recognize the agent MUST call `next()` so another answerer — or the
     * fail-closed default `'unavailable'` — gets the question. Throwing is
     * contained by the service and yields `'unavailable'`.
     * @param req - the pending decision (agent, tool identity, reason, signal).
     * @mode waterfall
     */
    'approval/request'(this: ApprovalService, req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: CallId
      reason?: string
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
  }
}

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * The closed outcome vocabulary of one approval request.
 *
 * - `'allowed-once'` — a one-shot grant for exactly the asked-about action;
 *   consumed by proceeding, never a durable authorization.
 * - `'rejected'` — an answerer (human or policy) said no.
 * - `'cancelled'` — the question was withdrawn: the prompt was dismissed, or
 *   the requesting execution aborted while the question was pending.
 * - `'unavailable'` — nobody composed could answer (no listener, none that
 *   recognizes the agent, or an answerer failed). Callers MUST fail closed on
 *   it, exactly like `'rejected'` — the two differ only for audit and wording.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Every {@link ApprovalOutcome}, for runtime normalization of answerer returns. */
const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * Whether the log currently sits inside an open turn (a `turn/start` not yet
 * closed by a `turn/end`) — the {@link ApprovalService.request} precondition.
 * The audit pair must be turn-enclosed: the turn is the durable log's
 * commit/replay boundary, so a bare event appended between turns is
 * indistinguishable from a crash tail and silently dropped on reload.
 */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = (events[index] as SessionEvent).type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * One concrete permission question. Identifies the action precisely enough
 * for an answerer to present it and for the audit events to reconstruct what
 * was asked — it deliberately does NOT carry tool arguments: a UI answerer
 * attaches the prompt to the already-streamed tool call via `callId` instead
 * of re-rendering the call.
 */
export interface ApprovalRequest {
  /**
   * The agent on whose behalf the question is asked. Routes the question (a
   * UI answerer only answers for agents it owns) and receives the audit
   * events on its session log.
   */
  agent: Agent
  /** The tool the question is about (presentation and audit). */
  toolName: string
  /**
   * The exact tool call being decided, when the asker has one — lets a UI
   * attach the prompt to the tool call it already streamed.
   */
  callId?: CallId
  /** The asker's human-readable explanation of WHY it is asking. */
  reason?: string
  /**
   * Aborting withdraws the question: the request settles `'cancelled'`
   * immediately and a late answer from a still-pending answerer is discarded.
   */
  signal?: AbortSignal
}

/**
 * The `ctx.approval` service: dispatches {@link ApprovalRequest}s to the
 * `approval/request` waterfall and audits every ask/outcome pair to the
 * requesting agent's session log. Stateless between requests — grants are
 * returned to the caller, never stored here.
 */
export class ApprovalService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'approval')
  }

  /**
   * Ask the composed answerers to decide one request. Requires an open turn
   * on the requesting agent's session — the audit pair below is turn-enclosed
   * by contract (the turn is the log's commit/replay boundary; an idle append
   * would be dropped as crash tail on reload) — and throws before appending
   * anything when called idle; asking outside a turn is a deferred design.
   * Within that precondition it always resolves to an outcome, never rejects:
   * an aborted signal yields `'cancelled'`, a missing or throwing answerer
   * yields `'unavailable'` (fail closed), and a rogue non-vocabulary return
   * value is normalized to `'unavailable'`. Appends the
   * `approval/asked`/`approval/decided` audit pair (log-only) around the
   * decision regardless of outcome.
   * @param req - the pending decision (agent, tool identity, reason, signal).
   * @returns the closed outcome; `'allowed-once'` is the only grant.
   */
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    if (!hasOpenTurn(req.agent.session.events)) {
      throw new Error(
        'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
        + 'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). '
        + 'Ask from inside the turn that needs the decision.',
      )
    }
    const id = ApprovalRequestId(randomUUID())
    req.agent.session.append('approval/asked', {
      id,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: req.callId } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    const outcome = await this.decide(req)
    req.agent.session.append('approval/decided', { id, outcome })
    return outcome
  }

  /** Dispatch the waterfall, contained and raced against `req.signal`. */
  private async decide(req: ApprovalRequest): Promise<ApprovalOutcome> {
    if (req.signal?.aborted) return 'cancelled'
    // Enter the promise chain BEFORE dispatching: a listener that throws
    // SYNCHRONOUSLY (before its first await) must land in the same rejection
    // path as an async one — `Promise.resolve(call())` would let it escape
    // the containment into the caller.
    const answer: Promise<ApprovalOutcome> = Promise.resolve().then(
      () => this.ctx.waterfall(this, 'approval/request', req, () => Promise.resolve<ApprovalOutcome>('unavailable')),
    ).then(
      // Normalize a rogue (non-vocabulary) answerer return to the fail-closed
      // outcome instead of leaking it into callers' closed-union switches.
      outcome => OUTCOMES.includes(outcome) ? outcome : 'unavailable',
      // A throwing answerer must fail the QUESTION closed, not the caller's
      // tool call open — the seam contains its callbacks.
      () => 'unavailable',
    )
    const signal = req.signal
    if (signal === undefined) return answer
    return await new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => { resolve('cancelled') }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        // After an abort won the race this resolve is a settled-promise no-op:
        // the late answer is discarded by construction.
        resolve(outcome)
      })
    })
  }
}

export default ApprovalService
