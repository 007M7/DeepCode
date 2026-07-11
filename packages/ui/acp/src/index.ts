/**
 * The Agent Client Protocol (ACP) bridge: a client-driver / UI plugin that exposes the harness
 * agent as an ACP server over JSON-RPC stdio, so editors (Zed and other ACP clients) can drive
 * it. The structured analogue of the readline `stdio-chat` plugin.
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from 'cordis'
import { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep as pathSep } from 'node:path'
import Schema from 'schemastery'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type ContentBlock as AcpContentBlock,
  type CreateElicitationRequest,
  type ElicitationContentValue,
  type EnumOption,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type Plan,
  type PlanEntry,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type Stream,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever, CallId } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from '@deepseek-ai/dsh-bash'
import { APPROVAL_POLICIES, effectiveApprovalPolicy, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { SessionEvent, TodoItem, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ToolCallView, ToolRegistry, ToolResultView, TerminalResultView } from '@deepseek-ai/dsh-tools'
// Side-effect type import: declaration-merges `ctx.sessionPersistence` onto
// Context (the bridge injects it and reads `list()` for load cwd validation).
import type {} from '@deepseek-ai/dsh-session-persistence'
// Side-effect type import: declaration-merges the `approval/request` waterfall
// the bridge answers for its own agents (see the approval answerer below).
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  UserInteractionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionOption,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-interaction'
import {
  acpPromptToText,
  harnessBlockToAcpContent,
  promptHasUnsupportedContent,
  turnEndToStopReason,
} from './codec.ts'

export const name = 'acp'
// Persistence enables loadSession; tools own call and result rendering.
export const inject = ['agents', 'sessions', 'sessionPersistence', 'tools', 'userInteraction']

/**
 * Build an ACP "invalid params" error whose human detail rides in the message.
 * `RequestError.invalidParams(data, additionalMessage)` keeps the standard
 * "Invalid params" message and appends `additionalMessage`, so we pass the
 * detail as `additionalMessage` (and no structured `data`).
 */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/**
 * Build an ACP "internal error" whose human detail rides in the message. Used
 * to reject a `session/prompt` whose turn ended in failure: a plain `Error`
 * thrown from a method handler is flattened to a generic "Internal error" on
 * the wire, so we wrap the detail in the SDK's `RequestError.internalError`
 * (which appends `additionalMessage`) to surface *why* the turn failed.
 */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

function sameWorkspaceCwd(left: string, right: string): boolean {
  return resolvePath(left) === resolvePath(right)
}

function optionDescription(option: AskUserQuestionOption): string {
  return option.description === undefined
    ? option.label
    : `${option.label}: ${option.description}`
}

function requireStringContent(
  content: Record<string, ElicitationContentValue> | null | undefined,
  key: string,
): string | undefined {
  const value = content?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function askAbortError(): UserInteractionError {
  return new UserInteractionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(askAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(askAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error), { cause: error }))
      },
    )
  })
}

function elicitationForQuestion(
  sessionId: SessionId,
  question: AskUserQuestionItem,
  options: AskUserQuestionOption[],
): CreateElicitationRequest {
  const title = question.header ?? 'Question'
  if (options.length === 0) {
    return {
      sessionId,
      mode: 'form',
      message: question.question,
      requestedSchema: {
        type: 'object',
        title,
        properties: {
          custom: { type: 'string', title: question.question },
        },
        required: ['custom'],
      },
    }
  }

  const choiceOptions: EnumOption[] = options.map(option => ({
    const: option.label,
    title: optionDescription(option),
  }))
  const choice = question.multiSelect === true
    ? {
      type: 'array' as const,
      title: question.question,
      description: 'Choose one or more options, or fill a custom answer below.',
      items: {
        anyOf: choiceOptions,
      },
    }
    : {
      type: 'string' as const,
      title: question.question,
      description: 'Choose one option, or fill a custom answer below.',
      oneOf: choiceOptions,
    }
  return {
    sessionId,
    mode: 'form',
    message: question.question,
    requestedSchema: {
      type: 'object',
      title,
      properties: {
        choice,
        custom: {
          type: 'string',
          title: 'Custom answer',
          description: 'Optional free-form answer. Leave empty to use the selected option.',
        },
      },
      required: [],
    },
  }
}

function stringArrayContent(
  content: Record<string, ElicitationContentValue> | null | undefined,
  key: string,
): string[] {
  const value = content?.[key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/** Plugin config: the agent template ACP sessions are created from. */
export interface AcpConfig {
  /** Model name for created agents (must have a registered adapter). */
  model?: string
  /**
   * Transport stream override. Production omits this (the plugin wires
   * `process.stdin`/`process.stdout` via `ndJsonStream`). Tests inject an
   * in-memory `Stream` (e.g. an `ndJsonStream` over a `Duplex` pair) to drive
   * the bridge without a subprocess. Not part of the schemastery `Config` —
   * it is a runtime-only seam, never set from a `cordis.yml`.
   */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  model: Schema.string(),
})

/**
 * Per-session bridge state. One per live ACP session; held in the `sessions`
 * map keyed by id (RFC 011 multi-session).
 */
interface SessionRecord {
  sessionId: SessionId
  agent: Agent
  /**
   * The owned-agent disposer (from the {@link AgentHandle} the factory returned).
   * Teardown calls it to unregister this ONE agent, stop its loop, await
   * quiescence, and remove its session — instead of leaving it for the bridge
   * fiber to reclaim.
   */
  dispose: () => Promise<void>
  /**
   * Resolves tool-owned presentation for THIS session's tool calls and remembers
   * each in-flight call's `(name, args)` so the matching `tool/result` can find
   * its tool. Per-session so two concurrent sessions never cross their in-flight
   * tool state.
   */
  presenter: ToolPresenter
  /**
   * Whether THIS session renders shell tools as terminal cards — snapshotted
   * from the client's `_meta.terminal_output` capability at session creation
   * (`session/new`/`session/load`), NOT re-read live. A capability snapshot per
   * session means the `tool_call` (which registers the terminal) and the matching
   * `tool_call_update` (which streams its output) ALWAYS agree, even if a later
   * `initialize` mutates the connection-level capability between them — otherwise
   * a re-`initialize` mid-call could orphan a `terminal_output` (call non-terminal,
   * result terminal) or clobber the card (call terminal, result non-terminal).
   */
  terminalEnabled: boolean
  /**
   * The in-flight `session/prompt`, or `undefined` when none is pending. A prompt resolves
   * with a {@link StopReason} or rejects with an Error (a turn that ended in failure). Settled
   * exactly once via {@link settlePrompt}.
   */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    turn: number | undefined
    logWatermark: number
  } | undefined
  /**
   * Config switches accepted while the session was IDLE, not yet anchored in its log.
   */
  pendingSwitches: { sandboxMode?: SandboxMode; approvalPolicy?: ApprovalPolicy }
}

/**
 * Drive the in-flight prompt's settle from the harness event stream.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // Capture the injected services NOW, during apply(), while we are inside this plugin's fiber
  // (where `inject` grants access).
  const agents = ctx.agents
  const sessionPersistence = ctx.sessionPersistence
  const logger = ctx.logger
  const tools = ctx.tools
  const userInteraction = ctx.userInteraction
  // A new ToolPresenter per session (and a throwaway per load replay), each given
  // this warn sink so a throwing tool presenter is logged, not propagated.
  const makePresenter = (agent?: Agent): ToolPresenter => new ToolPresenter(tools, (message) => { logger.warn(message) }, agent)

  // Live sessions keyed by id (RFC 011 multi-session), plus an agent→sessionId reverse map so
  // `agent/*` events (which carry only the Agent) demux in O(1).
  const sessions = new Map<SessionId, SessionRecord>()
  const bySession = new WeakMap<Agent, SessionId>()
  // Session ids whose `session/load` is mid-`resume()` (the slot is reserved before the async
  // resume so a pipelined load/new for the same id can't create two agents).
  const loadingIds = new Set<SessionId>()
  // Set once the bridge has torn down (disposal or client disconnect).
  let closed = false
  // Whether the client advertised the Zed `_meta.terminal_output` capability in `initialize`.
  let terminalOutputCap = false

  // Assigned at the bottom, before any agent event can fire (a session only
  // exists after `newSession`, which the client calls after construction), so
  // `notify` never observes it unset — no undefined guard needed.
  let conn: AgentSideConnection

  userInteraction.registerProvider({
    async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
      if (request.agent === undefined) {
        throw new UserInteractionError('ACP user questions must come from an agent-owned request', 'NO_AGENT')
      }
      const sessionId = bySession.get(request.agent)
      if (sessionId === undefined) {
        throw new UserInteractionError('ACP user question has no matching session', 'NO_SESSION')
      }
      const answers: AskUserQuestionAnswerItem[] = []
      for (const question of request.questions) {
        const options = question.options ?? []
        const response = await withAbort(conn.unstable_createElicitation(
          elicitationForQuestion(sessionId, question, options),
        ), request.signal).catch((error: unknown) => {
          if (error instanceof UserInteractionError) throw error
          throw new UserInteractionError('ACP elicitation request failed', 'ASK_FAILED', { cause: error })
        })
        if (response.action !== 'accept') {
          throw new UserInteractionError('ask_user_question was cancelled by the user', 'ASK_CANCELLED')
        }
        const custom = requireStringContent(response.content, 'custom')
        const selected = stringArrayContent(response.content, 'choice')
        if (custom === undefined && selected.length === 0) {
          throw new UserInteractionError('ask_user_question returned no answer', 'NO_ANSWER')
        }
        answers.push({
          id: question.id,
          selected: custom === undefined ? selected : [],
          ...custom !== undefined ? { custom } : {},
        })
      }
      return { answers }
    },
  })

  /**
   * Reject any RPC after the bridge has torn down. The `AgentSideConnection`
   * receive loop can outlive the plugin fiber — under an ACP-only HMR reload the
   * `agents`/`agent-loop` services stay up while the bridge's `ctx.on` listeners
   * and disposer are gone — so a late `session/new`/`load`/`prompt` could create
   * or drive an agent the bridge can no longer stream or settle. Every
   * state-affecting handler calls this first. (`initialize`/`authenticate` are
   * pure/stateless and may answer harmlessly.)
   */
  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  /** Resolve the live record for a sessionId, or throw an ACP error. */
  const requireSession = (sessionId: SessionId): SessionRecord => {
    const rec = sessions.get(sessionId)
    if (rec === undefined) {
      throw invalidParams(`unknown session: ${sessionId}`)
    }
    return rec
  }

  /** Push a `session/update` notification, swallowing post-close rejections. */
  const notify = (notification: SessionNotification): void => {
    // sessionUpdate returns a promise; a closed connection rejects it.
    /* v8 ignore next 3 -- the rejection only fires on a stdout/connection write
       failure (closed pipe), which the in-memory test transport never induces;
       the swallow is a defensive best-effort guard like the loop's emit traps */
    void Promise.resolve(conn.sessionUpdate(notification)).catch((error: unknown) => {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    })
  }

  /** Settle the in-flight prompt with a stop reason, exactly once (no-op if none pending). */
  const settlePrompt = (rec: SessionRecord, reason: StopReason): void => {
    const inflight = rec.inflight
    if (inflight === undefined) return
    rec.inflight = undefined
    inflight.resolve(reason)
  }

  /** Apply the single ACP prompt-settlement mapping for a completed turn. */
  const settleFromTurnEnd = (
    inflight: NonNullable<SessionRecord['inflight']>,
    reason: TurnEndReason,
  ): void => {
    if (reason.kind === 'error') {
      inflight.reject(internalError(`turn failed: ${reason.message}`))
    } else {
      inflight.resolve(turnEndToStopReason(reason))
    }
  }

  // --- Stream the harness event taxonomy to ACP session/update --------------

  // All content streaming AND the prompt settle flow through `session/event`, the canonical
  // log: every assistant/chunk and tool/call/result is logged, so translating from the log
  // makes live streaming and `session/load` replay share the identical path
  // (streamSessionEventUpdate).
  ctx.on('session/event', (session, event: SessionEvent) => {
    const rec = sessions.get(session.header.id)
    if (rec === undefined) return
    streamSessionEventUpdate(rec.sessionId, event, notify, rec.presenter, {
      enabled: rec.terminalEnabled,
      cwd: session.header.cwd,
    }, { includeUserMessages: false })
    const inflight = rec.inflight
    if (inflight === undefined) return
    if (event.type === 'turn/start') {
      // Tag the in-flight prompt with its owning turn — but only a `message`-triggered turn
      // (the kind a `send()` prompt produces).
      if (inflight.turn === undefined && event.data.trigger.kind === 'message') {
        inflight.turn = event.data.turn
      }
      return
    }
    // Settle only on the OWNING turn's end.
    if (event.type !== 'turn/end' || inflight.turn !== event.data.turn) return
    rec.inflight = undefined
    settleFromTurnEnd(inflight, event.data.reason)
  })

  // Settle fallback: a `session/event` listener registered before ACP that throws (on
  // `turn/start` OR `turn/end`) would, via cordis `emit`'s stop-on-throw, starve ACP's listener
  // above — the prompt would hang or, if only the turn number was missed, settle as the wrong
  // outcome.
  const settleFromLog = (rec: SessionRecord): void => {
    const inflight = rec.inflight
    if (inflight === undefined) return
    const events = rec.agent.session.events
    // The owning turn number: the captured one, or — if the live capture was starved — inferred
    // from the log as the first MESSAGE-triggered turn opened at/after the watermark.
    const owningTurn = inflight.turn ?? events.slice(inflight.logWatermark).find(
      (e): e is Extract<SessionEvent, { type: 'turn/start' }> =>
        e.type === 'turn/start' && e.data.trigger.kind === 'message',
    )?.data.turn
    // The owning turn's end in the log.
    const end = events.findLast(
      (e): e is Extract<SessionEvent, { type: 'turn/end' }> =>
        e.type === 'turn/end' && e.data.turn === owningTurn,
    )
    rec.inflight = undefined
    if (end === undefined) {
      // No owning turn / no clean turn/end (torn down mid-turn) → cancelled.
      inflight.resolve('cancelled')
      return
    }
    settleFromTurnEnd(inflight, end.data.reason)
  }

  // On a settle to idle/disposed, reconcile any still-pending prompt from the log (covers a
  // starved `session/event` listener — see settleFromLog).
  ctx.on('agent/status', (agent, status: AgentStatus) => {
    const sessionId = bySession.get(agent)
    if (sessionId === undefined) return
    const rec = sessions.get(sessionId)
    if (rec === undefined) return
    if (status === 'idle' || status === 'disposed') settleFromLog(rec)
  })

  // --- Approval answerer The bridge is the approval channel for the agents it owns: an `ask`
  // routed through `ctx.approval` (dsh-tools asks and sandbox escalation) becomes an editor
  // permission prompt attached to the already-streamed tool call.
  ctx.on('approval/request', (req, next) => {
    const sessionId = bySession.get(req.agent)
    // The protocol requires `toolCall` (the prompt renders attached to it), so
    // a request without a callId has nothing to attach to — delegate.
    if (sessionId === undefined || req.callId === undefined) return next()
    return conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: req.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      // Only the two advertised options exist; an unknown optionId from a
      // non-conforming client counts as a rejection, never a grant.
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  // --- The ACP Agent method surface -----------------------------------------

  /**
   * The session config options this composition can honor, with current values folded from the
   * AGENT'S own session log (`effectiveSandboxMode` / `effectiveApprovalPolicy` — the log is
   * the per-session store, so a `session/load` reports a resumed session's overrides with no
   * catch-up machinery), overlaid with the record's not-yet-anchored pending switches (see
   * {@link SessionRecord.pendingSwitches}).
   */
  const configOptionsFor = (agent: Agent, pending: SessionRecord['pendingSwitches'] = {}): SessionConfigOption[] => {
    const options: SessionConfigOption[] = []
    const defaultMode = ctx.get('bash')?.sandboxMode
    if (defaultMode !== undefined) {
      options.push({
        id: 'sandbox-mode',
        name: 'Sandbox',
        description: 'The file sandbox mode bash commands in this session run under.',
        category: 'mode',
        type: 'select',
        currentValue: pending.sandboxMode ?? effectiveSandboxMode(agent.session.events) ?? defaultMode,
        options: SANDBOX_MODES.map(mode => ({ value: mode, name: mode })),
      })
    }
    const approval = ctx.get('approval')
    if (approval !== undefined) {
      options.push({
        id: 'approval-policy',
        name: 'Approvals',
        description: 'ask: permission prompts reach you; never: they are rejected automatically.',
        type: 'select',
        // `?? 'ask'` also shields against a provided stand-in whose config
        // never went through the plugin schema (tests do this).
        currentValue: pending.approvalPolicy ?? effectiveApprovalPolicy(agent.session.events) ?? approval.config.policy ?? 'ask',
        options: APPROVAL_POLICIES.map(policy => ({ value: policy, name: policy })),
      })
    }
    return options
  }

  /**
   * Whether the session's log currently has an open turn — the last boundary
   * event is a `turn/start`. Decides whether a config switch may append NOW
   * (enclosed) or must wait for the next turn (see
   * {@link SessionRecord.pendingSwitches}). Read from the LOG, not
   * `agent.status`: status stays `running` across the gap between two queued
   * turns, where a bare append would still land outside any turn.
   */
  const isTurnOpen = (agent: Agent): boolean => {
    const events = agent.session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = (events[index] as SessionEvent).type
      if (type === 'turn/start') return true
      if (type === 'turn/end') return false
    }
    return false
  }

  /**
   * Anchor a record's pending switches into its (just-opened) turn, last
   * write per knob — skipping a value the session already effectively has,
   * so a net-zero idle flip-flop anchors NOTHING (the log records switches,
   * not select clicks).
   */
  const flushPendingSwitches = (rec: SessionRecord): void => {
    const pending = rec.pendingSwitches
    rec.pendingSwitches = {}
    const events = rec.agent.session.events
    if (pending.sandboxMode !== undefined
      && pending.sandboxMode !== (effectiveSandboxMode(events) ?? ctx.get('bash')?.sandboxMode)) {
      setSandboxMode(rec.agent.session, pending.sandboxMode)
    }
    if (pending.approvalPolicy !== undefined
      && pending.approvalPolicy !== (effectiveApprovalPolicy(events) ?? ctx.get('approval')?.config.policy ?? 'ask')) {
      setApprovalPolicy(rec.agent.session, pending.approvalPolicy)
    }
  }

  // Anchor idle switches during prompt-submit so persistence observes ordered in-turn events.
  ctx.on('agent/prompt-submit', (agent, _content, _source, next) => {
    const sessionId = bySession.get(agent)
    const rec = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (rec !== undefined) flushPendingSwitches(rec)
    return next()
  })

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      initialize(params: InitializeRequest): Promise<InitializeResponse> {
        // Echo the client's version if we support it, else our own. We support
        // exactly PROTOCOL_VERSION; any other requested version negotiates
        // down to ours (the client disconnects if it can't speak it).
        const protocolVersion = params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION
        // Remember the Zed terminal-output `_meta` capability: when set, bash and
        // other shell tools render as a terminal card (see streamSessionEventUpdate
        // + the terminal-rendering RFC). `_meta` is `{[k]: unknown} | null`, so
        // narrow defensively to a strict boolean true.
        terminalOutputCap = params.clientCapabilities?._meta?.['terminal_output'] === true
        return Promise.resolve({
          protocolVersion,
          // Fixed server identity: this bridge IS the harness ACP server, so the
          // branding is a literal, not config (no shipped surface sets it).
          agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
          agentCapabilities: {
            loadSession: true,
            // Baseline prompt blocks only: text plus resource_link rendered as
            // text. No image/audio/embeddedContext, no mcpCapabilities.
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        // No auth methods advertised; nothing to do. Present because the SDK
        // Agent interface requires it.
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateWorkspaceParams(params)
        validateMcpServers(params)
        const sessionId = SessionId(randomUUID())
        const handle = await agents.create({
          agentId: AgentId(sessionId),
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
        })
        // Creation is now asynchronous because it awaits the unpublished setup transaction.
        /* v8 ignore next 4 -- the in-memory transport rejects the in-flight RPC
           immediately on close; real stdio may let the handler resume */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        bySession.set(handle.agent, sessionId)
        sessions.set(sessionId, {
          sessionId,
          agent: handle.agent,
          dispose: () => handle.dispose(),
          presenter: makePresenter(handle.agent),
          terminalEnabled: terminalOutputCap,
          inflight: undefined,
          pendingSwitches: {},
        })
        const configOptions = configOptionsFor(handle.agent)
        return { sessionId, ...configOptions.length > 0 ? { configOptions } : {} }
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        assertOpen()
        // The wire `params.sessionId` is a raw protocol string; brand it once at
        // this entry so the session collections and the resume factory see a SessionId.
        const sessionId = SessionId(params.sessionId)
        if (sessions.has(sessionId) || loadingIds.has(sessionId)) {
          throw invalidParams(`session ${sessionId} is already loaded`)
        }
        validateWorkspaceParams(params)
        validateMcpServers(params)
        // Reserve this id's load slot before the await.
        loadingIds.add(sessionId)
        try {
          // Validate the persisted cwd before resuming — `list()` is a metadata-only read (no
          // full-log parse), so this rejects a session we can't honor WITHOUT ever
          // constructing/registering an agent (a post-resume reject would leak the registered
          // agent — cancel() does not unregister it — and wedge the id against re-load).
          const meta = (await sessionPersistence.list()).find(m => m.id === sessionId)
          if (meta !== undefined) {
            const persistedCwd = meta.cwd
            if (persistedCwd === undefined || !isAbsolute(persistedCwd)) {
              throw invalidParams(
                `session ${sessionId} has no absolute persisted cwd; cannot determine its workspace (it predates per-session cwd, or was created without one)`,
              )
            }
            if (!sameWorkspaceCwd(persistedCwd, params.cwd)) {
              throw invalidParams(`session ${sessionId} cwd mismatch: persisted ${persistedCwd}, requested ${params.cwd}`)
            }
          }
          const handle = await agents.resume({
            agentId: AgentId(sessionId),
            resumeSessionId: sessionId,
            agentOptions: agentOptions(config),
          })
          // The bridge may have torn down (disposal / client disconnect) while resume() was
          // pending.
          /* v8 ignore next 4 -- the in-memory test transport rejects the in-flight
             session/load request the instant it closes (before this post-await
             code runs), so the guard can't be hit in tests; it protects the real
             stdio path, where a closed pipe need not reject a mid-flight handler. */
          if (closed) {
            await handle.dispose()
            throw invalidParams('connection closed during session/load')
          }
          const agent = handle.agent
          bySession.set(agent, sessionId)
          // Snapshot the terminal capability ONCE for this session (used by both
          // the replay below and the post-load live stream) so a later
          // `initialize` can't desync the call/result of a tool card.
          const terminalEnabled = terminalOutputCap
          const record: SessionRecord = {
            sessionId,
            agent,
            dispose: () => handle.dispose(),
            presenter: makePresenter(agent),
            terminalEnabled,
            inflight: undefined,
            pendingSwitches: {},
          }
          sessions.set(sessionId, record)
          // Replay the persisted event log to the client as session/update.
          const replayPresenter = makePresenter(agent)
          const replayTerminal: TerminalRendering = {
            enabled: terminalEnabled,
            cwd: agent.session.header.cwd,
          }
          for (const event of agent.session.events) {
            streamSessionEventUpdate(sessionId, event, notify, replayPresenter, replayTerminal)
          }
          const configOptions = configOptionsFor(agent)
          return configOptions.length > 0 ? { configOptions } : {}
        } finally {
          loadingIds.delete(sessionId)
        }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const rec = requireSession(SessionId(params.sessionId))
        if (rec.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text and resource_link prompt content is supported; image/audio/embedded resource blocks are rejected rather than silently dropped')
        }
        const text = acpPromptToText(params.prompt)
        if (text.trim().length === 0) {
          // Reject up front rather than calling send(): an empty prompt would
          // queue no work, no turn would start, and the RPC would hang forever
          // waiting for a settle that never comes.
          throw invalidParams('empty prompt')
        }
        // Install the in-flight slot before send() (send does not synchronously flip status to
        // running; the session/event listener records the turn number and settle/rejects it).
        const stopReason = await new Promise<StopReason>((resolve, reject) => {
          rec.inflight = { resolve, reject, turn: undefined, logWatermark: rec.agent.session.events.length }
          rec.agent.send([{ type: 'text', text }])
        })
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const rec = sessions.get(SessionId(params.sessionId))
        if (rec === undefined) return Promise.resolve()
        // Queue-aware cancellation drops pending prompts as well as the active step.
        rec.agent.cancel('session/cancel')
        settlePrompt(rec, 'cancelled')
        return Promise.resolve()
      },

      setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const rec = requireSession(SessionId(params.sessionId))
        // Both advertised options are selects, so the boolean-shaped variant of
        // the request is a protocol misuse regardless of configId.
        if (typeof params.value !== 'string') {
          throw invalidParams(`config option ${params.configId} is a select; boolean values are not accepted`)
        }
        // The setters append one log-only event on this session's own log — the log is the
        // store (the sandbox RFC § Per-session mode switching): execution, the prompt section,
        // and the narrator all fold it from there, and a resumed session reports the override
        // back through configOptionsFor.
        switch (params.configId) {
          case 'sandbox-mode': {
            const defaultMode = ctx.get('bash')?.sandboxMode
            if (defaultMode === undefined || !SANDBOX_MODES.includes(params.value as SandboxMode)) {
              throw invalidParams(`unknown sandbox-mode value ${JSON.stringify(params.value)}`)
            }
            const value = params.value as SandboxMode
            // A no-op switch (the value the session already shows — pending,
            // else fold, else default) is acknowledged without recording
            // anything: clients that re-push current selections on session
            // start must not mint override events out of thin air.
            const current = rec.pendingSwitches.sandboxMode ?? effectiveSandboxMode(rec.agent.session.events) ?? defaultMode
            if (value === current) break
            if (isTurnOpen(rec.agent)) setSandboxMode(rec.agent.session, value)
            else rec.pendingSwitches.sandboxMode = value
            break
          }
          case 'approval-policy': {
            const approval = ctx.get('approval')
            if (approval === undefined || !APPROVAL_POLICIES.includes(params.value as ApprovalPolicy)) {
              throw invalidParams(`unknown approval-policy value ${JSON.stringify(params.value)}`)
            }
            const value = params.value as ApprovalPolicy
            const current = rec.pendingSwitches.approvalPolicy ?? effectiveApprovalPolicy(rec.agent.session.events) ?? approval.config.policy ?? 'ask'
            if (value === current) break
            if (isTurnOpen(rec.agent)) setApprovalPolicy(rec.agent.session, value)
            else rec.pendingSwitches.approvalPolicy = value
            break
          }
          default:
            throw invalidParams(`unknown config option ${JSON.stringify(params.configId)}`)
        }
        // The spec requires the COMPLETE refreshed config state in the response
        // (a change may cascade); ours are independent, but the contract holds.
        return Promise.resolve({ configOptions: configOptionsFor(rec.agent, rec.pendingSwitches) })
      },
    }
  }

  // --- Connection lifecycle --------------------------------------------------

  // The transport stream.
  /* v8 ignore next 4 -- production stdio wiring; tests always inject config.stream */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  /**
   * Tear ALL live sessions down to quiescence (docs/defensive-patterns.md "dispose must reach
   * quiescence"): for each session settle any pending prompt `cancelled`, then run that
   * session's {@link AgentHandle} `dispose()` — which stops the loop (sets `disposed`, aborts
   * the in-flight step), AWAITS the loop's exit (the final `turn/end` + `session/flush` are
   * captured while `onAppend` is still attached), unregisters the agent, and removes its
   * session from the store.
   */
  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    // Memoize: disposal and client-disconnect can both fire. The first call owns
    // the teardown; later callers await the SAME promise so `fiber.dispose()`
    // never returns before an in-flight close teardown has finished.
    if (quiescing !== undefined) return quiescing
    // Mark closed BEFORE draining: a `session/load` mid-`resume()` (no record
    // installed yet) must observe this after its await and refuse to install a
    // post-teardown record. Set even when there are no live sessions.
    closed = true
    const recs = [...sessions.values()]
    sessions.clear()
    if (recs.length === 0) return Promise.resolve()
    quiescing = (async () => {
      await Promise.all(recs.map(async (rec) => {
        settlePrompt(rec, 'cancelled')
        // Per-agent dispose (the AgentHandle disposer): unregister this agent,
        // stop its loop (sets disposed + aborts the in-flight step), await
        // quiescence (the loop exit + final flush), and remove its session — so
        // a bare client disconnect leaves NO registered agent and NO
        // session-store entry, not just an idled-but-still-registered one.
        await rec.dispose()
      }))
    })()
    return quiescing
  }

  // Client disconnect: when the ACP transport closes (editor quits, pipe EOF), the in-flight
  // turn would otherwise keep running and its `session/update` writes would be silently
  // swallowed by `notify()`.
  /* v8 ignore start -- the .catch arrow is a defensive guard: conn.closed
     settling rejected or quiesce() throwing on an already-closed connection is
     not reproducible through the in-memory test transport (it never severs
     mid-run), and there is nothing else to act on once the connection is gone —
     the swallow mirrors notify(). */
  void conn.closed.then(quiesce).catch((error: unknown) => {
    logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
  })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from the plugin config, omitting absent fields
 * (exactOptionalPropertyTypes: never assign `undefined` to an optional key).
 * Exported for unit coverage of both the present and absent branches.
 * @param config - the plugin config carrying the optional model name.
 * @returns the per-agent options, with `model` present only when configured.
 */
export function agentOptions(config: AcpConfig): { model?: string } {
  return {
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

/**
 * Validate the `cwd`/`additionalDirectories` contract shared by `session/new` and
 * `session/load`: `cwd` must be absolute (a relative path would be ambiguous as a workspace
 * root).
 */
function validateWorkspaceParams(params: { cwd: string; additionalDirectories?: string[] }): void {
  if (!isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported in this MVP')
  }
}

function validateMcpServers(params: { mcpServers?: unknown[] }): void {
  if (params.mcpServers !== undefined && params.mcpServers.length > 0) {
    throw invalidParams('mcpServers is not supported in this MVP')
  }
}

/**
 * Translate one session event into zero or more ACP updates.
 * @param sessionId - the ACP session id stamped on every emitted notification.
 * @param event - the harness session event to translate.
 * @param notify - best-effort update sink.
 * @param presenter - tool render resolver; defaults to generic presentation.
 * @param terminal - terminal rendering context; disabled by default.
 * @param options - controls replay of user messages.
 */
export function streamSessionEventUpdate(
  sessionId: SessionId,
  event: SessionEvent,
  notify: (notification: SessionNotification) => void,
  presenter: Pick<ToolPresenter, 'call' | 'result'> = nullToolPresenter,
  terminal: TerminalRendering = noTerminalRendering,
  options: { includeUserMessages?: boolean } = {},
): void {
  const includeUserMessages = options.includeUserMessages ?? true
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        notify({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } } })
      } else if (chunk.type === 'reasoning-delta') {
        notify({ sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } } })
      }
      return
    }
    case 'user/message': {
      if (!includeUserMessages) return
      // Replay the user's prompt so a loaded session shows both sides of each
      // turn. Live prompt turns suppress this path to avoid duplicating what
      // the client just sent.
      for (const block of event.data.content) {
        const content = harnessBlockToAcpContent(block)
        if (content !== undefined) {
          notify({ sessionId, update: { sessionUpdate: 'user_message_chunk', content } })
        }
      }
      return
    }
    case 'tool/call': {
      const view = presenter.call(event.data.callId, event.data.name, event.data.arguments)
      notify({ sessionId, update: toolCallUpdate(event.data.callId, view, terminal) })
      return
    }
    case 'tool/result': {
      const view = presenter.result(event.data.callId, event.data.content, event.data.isError, event.data.meta)
      notify({ sessionId, update: toolResultUpdate(event.data.callId, view, event.data.isError, terminal) })
      return
    }
    case 'todo/write': {
      notify({ sessionId, update: { sessionUpdate: 'plan', ...todosToPlan(event.data.todos) } })
      return
    }
    // turn/step boundaries, context/message, steering,
    // assistant/message — no direct ACP client update.
    default:
      return
  }
}

/**
 * Map a harness todo list to an ACP `plan` body. ACP's `PlanEntry` requires
 * `content` + `priority` + `status`, but a {@link TodoItem} carries no priority,
 * so synthesize a constant `'medium'` on every entry; `status` maps 1:1 (the
 * harness status triple IS `PlanEntryStatus`). The ACP client REPLACES its whole
 * plan on each `plan` update, matching the harness's whole-list-replace
 * semantics, so no per-entry diffing is needed.
 * @param todos - the harness todo list (the whole list, not a diff).
 * @returns the ACP plan body, one entry per todo.
 */
export function todosToPlan(todos: TodoItem[]): Plan {
  return { entries: todos.map((todo): PlanEntry => ({ content: todo.content, priority: 'medium', status: todo.status })) }
}

/**
 * Per-connection terminal-rendering context threaded into
 * {@link streamSessionEventUpdate}: whether the client advertised the
 * `_meta.terminal_output` capability, and the session's workspace cwd (the
 * default terminal-card header when a tool doesn't supply its own). Kept out of
 * the pure translator's required params so the no-capability / no-presenter
 * tests stay terse.
 */
export interface TerminalRendering {
  enabled: boolean
  /** The session workspace cwd (terminal-card header default); `undefined` when the session has none. */
  cwd: string | undefined
}

/** Default: terminal rendering off (the ` ```console ` text fallback path). */
const noTerminalRendering: TerminalRendering = { enabled: false, cwd: undefined }

/**
 * Resolves tool-owned presentation for a session's tool-call events. A tool declares
 * `presentCall`/`presentResult` (see `dsh-tools`) returning a `card`-tagged {@link
 * ToolCallView}/{@link ToolResultView}; this looks them up by name in the registry and applies
 * a generic fallback when a tool defines neither. The returned view is what {@link
 * streamSessionEventUpdate} switches on.
 */
export class ToolPresenter {
  private readonly pending = new Map<CallId, { name: string; args: unknown; card: ToolCallView['card'] }>()

  /**
   * @param tools the registry to resolve tool definitions by name.
   * @param onError invoked when a tool's `presentCall`/`presentResult` THROWS;
   *   the presenter swallows the error and falls back to the generic
   *   presentation so a buggy display callback can never fail a live turn or a
   *   `session/load` replay (docs/defensive-patterns.md "contain callback exceptions at the
   *   boundary"). Defaults to a no-op for callers that don't supply a logger.
   */
  constructor(
    private readonly tools: Pick<ToolRegistry, 'get'>,
    private readonly onError: (message: string) => void = () => {},
    /**
     * The agent whose view resolves tool presentations: a scoped/shadowed
     * tool presents with ITS OWN presentCall/presentResult — the same
     * definition that executed — not a same-named global's. Absent (a replay
     * with no live agent) the global view presents.
     */
    private readonly agent?: Agent,
  ) {}

  /**
   * Pending-state render intent for a `tool/call`; remembers `(name, args, card)`
   * for the matching result.
   * @param callId - the call id the matching `tool/result` will look up.
   * @param name - the tool name, resolved against the registry for `presentCall`.
   * @param argsJson - the raw arguments JSON from the event; parsed for the view
   * (a non-JSON string is surfaced raw).
   * @returns the tool-owned view, or the generic fallback (title = tool name,
   * kind `other`, parsed args as raw input) when the tool defines none or threw.
   */
  call(callId: CallId, name: string, argsJson: string): ToolCallView {
    const args = parseToolArguments(argsJson)
    let present: ToolCallView | undefined
    try {
      present = this.tools.get(name, this.agent)?.presentCall?.(args)
    } catch (error: unknown) {
      // A throwing presentCall must not break streaming: log and fall back.
      this.onError(`acp: tool "${name}" presentCall threw, using generic presentation: ${String(error)}`)
      present = undefined
    }
    // No tool-owned presentation: fall back to the tool name as the title, the full parsed args
    // as the raw input, and kind `other` (the generic card).
    const view: ToolCallView = present ?? { card: 'generic', title: name, kind: 'other', rawInput: args }
    this.pending.set(callId, { name, args, card: view.card })
    return view
  }

  /**
   * Resolve completed presentation from the remembered tool call.
   * @param callId - matching call id; unknown ids use raw content.
   * @param content - fallback result content.
   * @param isError - result error flag.
   * @param meta - optional tool metadata.
   * @returns tool-owned view or normalized generic fallback.
   */
  result(callId: CallId, content: ContentBlock[], isError: boolean, meta?: unknown): ToolResultView {
    const call = this.pending.get(callId)
    this.pending.delete(callId)
    if (call === undefined) return { card: 'generic', content }
    let present: ToolResultView | undefined
    try {
      present = this.tools.get(call.name, this.agent)
        ?.presentResult?.(call.args, { content, isError, ...meta !== undefined ? { meta } : {} })
    } catch (error: unknown) {
      // Presentation failure falls back without breaking replay or streaming.
      this.onError(`acp: tool "${call.name}" presentResult threw, using raw result: ${String(error)}`)
      present = undefined
    }
    if (present === undefined) return { card: 'generic', content }
    // A terminal result requires a terminal call card.
    if (present.card === 'terminal' && call.card !== 'terminal') return { card: 'generic', content }
    // Preserve raw content when a generic presenter changes only metadata.
    if (present.card === 'generic' && present.content === undefined) return { ...present, content }
    return present
  }
}

/**
 * The no-op presenter used when no tool registry is available (e.g. the pure
 * translator tests): every tool gets the generic fallback presentation, and
 * results pass their raw content through unchanged.
 */
export const nullToolPresenter: Pick<ToolPresenter, 'call' | 'result'> = {
  call: (_callId, name, argsJson) => ({ card: 'generic', title: name, kind: 'other', rawInput: parseToolArguments(argsJson) }),
  result: (_callId, content) => ({ card: 'generic', content }),
}

/** Parse a tool-call arguments JSON string for `rawInput`; raw string on failure. */
function parseToolArguments(args: string): unknown {
  try {
    return args ? JSON.parse(args) : {}
  } catch {
    // The model produced non-JSON arguments; surface the raw string rather
    // than dropping it. (The harness tool layer handles validation; here we
    // only feed the client's tool-call UI.)
    return args
  }
}

/** Map harness tool-result content blocks to ACP tool-call content (text only). */
function toolResultContent(blocks: ContentBlock[]): { type: 'content'; content: AcpContentBlock }[] {
  const out: { type: 'content'; content: AcpContentBlock }[] = []
  for (const block of blocks) {
    const content = harnessBlockToAcpContent(block)
    if (content !== undefined) out.push({ type: 'content', content })
  }
  return out
}

/** The `session/update` payload for a `tool_call` / `tool_call_update`. */
type ToolCallSessionUpdate = SessionNotification['update']

/** An ACP tool-call content block (a text/image `content`, a `diff`, or a `terminal`). */
type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

/**
 * Relativize a file card's TITLE path against the session workspace cwd, so a card reads `Read
 * src/foo.ts` rather than `/abs/proj/src/foo.ts` — matching the reference ACP adapter's
 * `toDisplayPath`.
 */
function displayTitle(title: string, rawPath: string | undefined, sessionCwd: string | undefined): string {
  if (rawPath === undefined || sessionCwd === undefined || !isAbsolute(rawPath) || !isAbsolute(sessionCwd)) return title
  const rel = relativePath(sessionCwd, rawPath)
  // Relativize only paths contained by the workspace; keep the workspace root absolute.
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${pathSep}`)) return title
  return title.split(rawPath).join(rel)
}

/**
 * Resolve the terminal card's header cwd. A `TerminalCallView.cwd` (a model
 * `workdir`) wins when ABSOLUTE; a RELATIVE one resolves against the session cwd
 * (matching how `dsh-tool-bash` resolves a relative workdir for execution, so the
 * header matches where the command actually ran); when the view gives no cwd, the
 * session workspace cwd is the default. Returns `undefined` only when neither the
 * view nor the session supplies one (Zed then shows "current directory").
 */
function terminalCwd(viewCwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (viewCwd === undefined) return sessionCwd
  if (isAbsolute(viewCwd)) return viewCwd
  return sessionCwd !== undefined ? resolvePath(sessionCwd, viewCwd) : viewCwd
}

/**
 * Build the `tool_call` (pending) `session/update` from a tool's render intent.
 * Switches on `view.card`: a `generic` card maps title/kind/rawInput/content/
 * locations; a `diff` card emits `{ type: 'diff' }` content blocks (the editor's
 * inline diff) plus follow-along locations; a `terminal` card renders as a
 * terminal when the client is capable (a `terminal` content block + the
 * `_meta.terminal_info` cwd header) and otherwise falls back to a generic execute
 * card whose body is the description. File-card titles are relativized against the
 * session cwd (see {@link displayTitle}).
 */
function toolCallUpdate(callId: CallId, view: ToolCallView, terminal: TerminalRendering): ToolCallSessionUpdate {
  switch (view.card) {
    case 'generic':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        // Relativize the title against the session cwd when the card carries a
        // file location (a read/file card); a location-less card (bash, todo)
        // has no path to relativize, so the title is used as-is.
        title: displayTitle(view.title, view.locations?.[0]?.path, terminal.cwd),
        kind: view.kind ?? 'other',
        status: 'in_progress',
        ...view.rawInput !== undefined ? { rawInput: view.rawInput } : {},
        ...view.locations !== undefined ? { locations: view.locations } : {},
        ...view.content !== undefined && view.content.length > 0 ? { content: toolResultContent(view.content) } : {},
      }
    case 'diff': {
      const rawPath = view.locations?.[0]?.path ?? view.diffs[0]?.path
      const content: AcpToolCallContent[] = view.diffs.map(d => ({ type: 'diff', path: d.path, oldText: d.oldText, newText: d.newText }))
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: displayTitle(view.title, rawPath, terminal.cwd),
        kind: 'edit',
        status: 'in_progress',
        ...view.locations !== undefined ? { locations: view.locations } : {},
        ...content.length > 0 ? { content } : {},
      }
    }
    case 'terminal': {
      // A terminal-rendered call gets a terminal CARD when the client supports it: the
      // description renders ABOVE the card, then the terminal block, plus `_meta.terminal_info`
      // (the cwd header).
      const asTerminal = terminal.enabled
      const description: AcpToolCallContent[] = view.description !== undefined
        ? [{ type: 'content', content: { type: 'text', text: view.description } }]
        : []
      const content: AcpToolCallContent[] = [
        ...description,
        ...asTerminal ? [{ type: 'terminal' as const, terminalId: callId }] : [],
      ]
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: view.title,
        kind: 'execute',
        status: 'in_progress',
        rawInput: view.title,
        ...content.length > 0 ? { content } : {},
        ...asTerminal
          ? { _meta: { terminal_info: { terminal_id: callId, cwd: terminalCwd(view.cwd, terminal.cwd) } } }
          : {},
      }
    }
    default:
      return assertNever(view, 'ToolCallView.card')
  }
}

/** The `terminal_exit` `_meta` entry for a completed terminal call. */
interface TerminalExitMeta {
  terminal_exit?: { terminal_id: string; exit_code?: number; signal?: string }
}

/**
 * Build the optional `terminal_exit` portion of a `tool_call_update`'s `_meta`
 * from a terminal result: a `signal` death yields `{signal}`, an `exitCode`
 * yields `{exit_code}`, and neither yields nothing (the card simply shows no exit
 * pill). Spread into the `_meta` object alongside `terminal_output`.
 */
function terminalExitMeta(callId: string, view: TerminalResultView): TerminalExitMeta {
  if (view.signal !== undefined) return { terminal_exit: { terminal_id: callId, signal: view.signal } }
  if (view.exitCode !== undefined) return { terminal_exit: { terminal_id: callId, exit_code: view.exitCode } }
  return {}
}

/**
 * Build the `tool_call_update` (completed) `session/update` from a result render intent.
 */
function toolResultUpdate(callId: CallId, view: ToolResultView, isError: boolean, terminal: TerminalRendering): ToolCallSessionUpdate {
  const status = isError ? 'failed' as const : 'completed' as const
  switch (view.card) {
    case 'terminal': {
      const output = view.output ?? ''
      if (terminal.enabled) {
        return {
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          status,
          ...view.title !== undefined ? { title: view.title } : {},
          _meta: {
            terminal_output: { terminal_id: callId, data: output },
            ...terminalExitMeta(callId, view),
          },
        }
      }
      // No terminal capability: the bridge derives the fenced ```console fallback.
      const fenced = `\`\`\`console\n${output.replace(/\n+$/, '')}\n\`\`\``
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        content: [{ type: 'content', content: { type: 'text', text: fenced } }],
        ...view.title !== undefined ? { title: view.title } : {},
      }
    }
    case 'generic':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        // The presenter fills a generic result's content from the raw result, so
        // `content` is always defined here; the guard keeps this total for a
        // directly-constructed view.
        /* v8 ignore next -- content always defined via the presenter (see above) */
        ...view.content !== undefined ? { content: toolResultContent(view.content) } : {},
        ...view.title !== undefined ? { title: view.title } : {},
      }
    case 'diff': {
      // Result diff content replaces the pending card's call-side diff.
      const content: AcpToolCallContent[] = view.diffs.map(d => ({ type: 'diff', path: d.path, oldText: d.oldText, newText: d.newText }))
      // Relativize the replacement title against the session cwd from the diff
      // path, exactly as the call-side card does — `tool_call_update.title`
      // replaces the card header, so a raw absolute path here would undo the
      // pending card's relativized title.
      const title = view.title !== undefined ? displayTitle(view.title, view.diffs[0]?.path, terminal.cwd) : undefined
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status,
        ...content.length > 0 ? { content } : {},
        ...title !== undefined ? { title } : {},
      }
    }
    default:
      return assertNever(view, 'ToolResultView.card')
  }
}
