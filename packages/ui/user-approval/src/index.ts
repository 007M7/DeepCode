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
 * `tools/pre-execute` `ask` decision and the sandbox post-denial escalation —
 * so every asker shares one outcome
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
 * The seam also owns the per-session POLICY tier (the sandbox RFC § Per-session mode switching):
 * `effective = fold(the session's 'approval/policy' events, last one wins)
 * ?? config.policy` — the session log is the store, so an override survives
 * restart by replay. The service resolves `'never'` sessions to
 * `'rejected'` inside `request()` before dispatching any answerer (no
 * registration order, including a later `prepend`, can precede it); a prompt section states `'never'`
 * (and only `'never'` — an availability promise is unknowable without
 * asking); an `agent/pre-step` narrator explains a switch to the model in at
 * most one coalesced notice per step.
 *
 * @module @deepseek-ai/dsh-user-approval
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from 'cordis'
import z from 'schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'

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
    /**
     * The session's approval policy was switched — log-only, durable,
     * replayable, never in the model transcript (the model learns the policy
     * from the prompt section and the narrator's notices). The LAST such
     * event is the session's override ({@link effectiveApprovalPolicy});
     * who asked for it is derivable from position (an event after the log's
     * last `request/header*` was a runtime switch by the user).
     */
    'approval/policy': { policy: ApprovalPolicy }
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
 * A session's approval policy — what happens to an {@link ApprovalService}
 * ask BEFORE any interactive answerer sees it:
 *
 * - `'ask'` (the default) — delegate to the composed answerers; with none
 *   composed the chain falls through to the fail-closed `'unavailable'`
 *   (exactly today's behavior).
 * - `'never'` — never prompt anyone: every ask resolves `'rejected'`
 *   deterministically. The strict headless stance (CI, unattended runs) and
 *   the only policy value stated in the system prompt — unlike `'ask'`, its
 *   outcome is knowable without asking, so stating it cannot overclaim.
 */
export type ApprovalPolicy = 'ask' | 'never'

/** Every {@link ApprovalPolicy}, for option advertisement and runtime validation of untrusted policy strings. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never']

/**
 * The prompt sentence stating a `'never'` policy — visibility for the one
 * deterministic policy (see {@link ApprovalPolicy}). Narrator persistence
 * does NOT parse this prose: deployments can quote it in a persona or another
 * section, so the section also emits a source-owned marker.
 */
const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'

/** Source-owned prompt markers used to reconstruct the policy in a logged header. */
const POLICY_MARKERS = {
  ask: '<!-- dsh-user-approval-policy:ask -->',
  never: '<!-- dsh-user-approval-policy:never -->',
} as const satisfies Record<ApprovalPolicy, string>

/**
 * Read the policy fact emitted by this service from a logged system prompt.
 * The section is ordered after deployment persona text, and the last marker
 * wins so a persona quoting an earlier marker cannot shadow the service's own
 * contribution. Ordinary policy prose is deliberately ignored.
 */
function toldApprovalPolicy(system: string | undefined): ApprovalPolicy | undefined {
  if (system === undefined) return undefined
  const ask = system.lastIndexOf(POLICY_MARKERS.ask)
  const never = system.lastIndexOf(POLICY_MARKERS.never)
  if (ask < 0 && never < 0) return undefined
  return never > ask ? 'never' : 'ask'
}

/**
 * The session's approval-policy override: the last `approval/policy` event in
 * the log, or undefined when the session never switched (callers apply the
 * plugin's configured default). The pure fold — resume needs no catch-up
 * machinery because replaying the log IS the state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the policy of the last switch event, or undefined without one.
 */
export function effectiveApprovalPolicy(events: readonly SessionEvent[]): ApprovalPolicy | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'approval/policy') return event.data.policy
  }
  return undefined
}

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
 * THE write path for a session's approval-policy override: appends exactly
 * one `approval/policy` event — the switch IS its event; nothing mutates
 * policy state out of band. Takes effect on the session's next ask and next
 * prompt assembly (the consumers fold on every read).
 * @param session - the session the override belongs to.
 * @param policy - the policy every subsequent ask for this session resolves
 *   under (until the next switch).
 */
export function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void {
  session.append('approval/policy', { policy })
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

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * The deployment's default {@link ApprovalPolicy} for sessions without an
   * `approval/policy` override — `'ask'` delegates to the composed answerers
   * (fail-closed with none); `'never'` auto-rejects every ask without
   * prompting (the deterministic CI/unattended stance).
   */
  policy?: ApprovalPolicy
}

/**
 * The `ctx.approval` service: dispatches {@link ApprovalRequest}s to the
 * `approval/request` waterfall and audits every ask/outcome pair to the
 * requesting agent's session log. Stateless between requests — grants are
 * returned to the caller, never stored here.
 *
 * Owns the policy tier too (`effective = fold(the session's 'approval/policy'
 * events) ?? config.policy`): `request()` resolves `'never'` to `'rejected'`
 * before dispatching any interactive answerer, a per-agent prompt section
 * states a `'never'` policy (and only that one in prose — an `'ask'` promise
 * could overclaim an answerer that headless compositions do not have), and an
 * `agent/pre-step` narrator injects at most one coalesced notice when a
 * session's effective policy moved past what the model was last told.
 */
export class ApprovalService extends Service {
  static Config: z<Config> = z.object({
    policy: z.union(['ask', 'never'] as const).default('ask'),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'approval')

    const effective = (agent: Agent): ApprovalPolicy => this.effectivePolicy(agent)

    // Visibility layer 1, scoped on the prompt registry so headless
    // compositions mount the seam without it: state the one deterministic
    // policy per session. 'ask' renders only a source-owned state marker —
    // stating "you will be asked" would overclaim in a composition with no
    // answerer. The marker, not deployment-controlled prose, is what the
    // restart narrator reads back from the logged request header.
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.section({
        name: 'approval:policy',
        order: 115,
        text: (context) => {
          const agent = context.agent
          // A bare assemble() (tests, diagnostics) has no session to state.
          if (agent === undefined) return ''
          const policy = effective(agent)
          return policy === 'never' ? `${NEVER_SENTENCE}\n${POLICY_MARKERS.never}` : POLICY_MARKERS.ask
        },
      })
    })

    // Visibility layer 2: the boundary narrator. pre-step runs after prompt
    // assembly but before the request history is derived, so the notice is
    // seen by THIS step's request: idle-time flip-flops coalesce at the
    // turn's first step (net-zero → nothing), and a mid-turn switch is
    // narrated no later than the next step. What each session was last told
    // is in-memory with a log-derived fallback (the folded header's system
    // text), so restarts lose nothing. Attribution is positional: an
    // override event after the log's last `request/header*` was a runtime
    // switch by the user; otherwise the configured default moved under the
    // session (operator/config).
    const narrated = new WeakMap<Agent['session'], ApprovalPolicy>()
    ctx.on('agent/pre-step', (agent) => {
      const session = agent.session
      const events = session.events
      let overrideIndex = -1
      let headerIndex = -1
      for (let index = events.length - 1; index >= 0 && (overrideIndex < 0 || headerIndex < 0); index -= 1) {
        const event = events[index] as (typeof events)[number]
        if (overrideIndex < 0 && event.type === 'approval/policy') {
          overrideIndex = index
        } else if (headerIndex < 0 && (event.type === 'request/header' || event.type === 'request/header-delta')) {
          headerIndex = index
        }
      }
      // Same fold effectivePolicy performs — override is scanned here anyway
      // for POSITIONAL attribution; the default lives once, in the method.
      const current = this.effectivePolicy(agent)
      const header = session.requestHeader()
      const told = narrated.get(session) ?? toldApprovalPolicy(header?.system)
      narrated.set(session, current)
      // Cold start (nothing ever told) narrates nothing — the section about
      // to go out states the truth, and there is no delta to explain.
      if (told === undefined || told === current) return
      const cause = overrideIndex > headerIndex ? 'changed by the user' : 'changed by the operator/config'
      agent.inject(
        [{ type: 'text', text: `The approval policy changed from "${told}" to "${current}" (${cause}).` }],
        { source: { kind: 'plugin', plugin: 'user-approval' } },
      )
    })
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

  /**
   * The session's effective policy: its own `approval/policy` fold, else the
   * configured default (the schema already defaulted an omitted policy to
   * `'ask'`; the `??` only narrows the optional-input TYPE).
   * @param agent - the agent whose session's policy applies.
   * @returns the policy every ask for this agent resolves under right now.
   */
  private effectivePolicy(agent: Agent): ApprovalPolicy {
    return effectiveApprovalPolicy(agent.session.events) ?? this.config.policy ?? 'ask'
  }

  /** Dispatch the waterfall, contained and raced against `req.signal`. */
  private async decide(req: ApprovalRequest): Promise<ApprovalOutcome> {
    if (req.signal?.aborted) return 'cancelled'
    // The 'never' policy is decided HERE, before any dispatch: a listener
    // registered with `prepend: true` after this service mounts would sit
    // ahead of any gate LISTENER, so a listener-shaped gate cannot keep the
    // documented promise that 'never' rejects deterministically regardless
    // of registration order — only the service's own request path can.
    if (this.effectivePolicy(req.agent) === 'never') return 'rejected'
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
