/**
 * Multi-session ACP server bridge over JSON-RPC stdio. Creates or resumes
 * agents, routes their events, settles prompts by turn, and answers approvals.
 * Each session keeps independent presentation and prompt-correlation state so
 * concurrent streams cannot cross. Stdout is reserved for protocol frames.
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: resolves `ctx.get('permission')` to the service.
import type {} from '@deepseek-ai/dsh-permission'
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
// Interface services back advertised loading, tool-owned presentation with a generic fallback, and interaction.
// TODO(acp-session-inject): remove `sessions`; the bridge never reads it, and ownership is already behind `agents`.
export const inject = ['agents', 'sessions', 'sessionPersistence', 'tools', 'userInteraction']

/** Build an ACP invalid-params error with visible human detail. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Build an ACP internal error with visible detail; plain handler errors are flattened on wire. */
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
  /** Runtime-only transport override for tests; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  model: Schema.string(),
})

/** Per-session bridge state keyed by ACP session id. */
interface SessionRecord {
  sessionId: SessionId
  agent: Agent
  /** Owned-agent disposer that reaches per-session quiescence. */
  dispose: () => Promise<void>
  /** Per-session tool presenter and in-flight call correlation. */
  presenter: ToolPresenter
  /** Session-creation snapshot of terminal-card support for call/result consistency. */
  terminalEnabled: boolean
  /** In-flight prompt and its captured turn number for exact settlement. */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    turn: number | undefined
  } | undefined
  /**
   * Idle config changes awaiting a turn-enclosed log anchor; last write wins.
   * Responses overlay them, but a restart before anchoring restores the logged fold.
   */
  pendingSwitches: { preset?: string }
}

/**
 * Drive the in-flight prompt's settle from the harness event stream. The bridge
 * settles off the durable `turn/end` event for the prompt's own turn. Session
 * contains post-commit observers independently, and this listener performs
 * correlation in a `finally` so presentation failure cannot starve settlement.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // Handlers run later outside this injection scope, so capture services now.
  const agents = ctx.agents
  const sessionPersistence = ctx.sessionPersistence
  const logger = ctx.logger
  const tools = ctx.tools
  const userInteraction = ctx.userInteraction
  // Presenter failures are logged and contained per session or replay.
  const makePresenter = (agent?: Agent): ToolPresenter => new ToolPresenter(tools, (message) => { logger.warn(message) }, agent)

  // TODO(derive-acp-session-id): derive event ids from `agent.session`, verify ownership, then remove the reverse map.
  // Agent events currently carry only the Agent, so retain `SessionRecord.sessionId` and update both indexes together.
  // Dropping the forward record lets the weak reverse entry expire.
  const sessions = new Map<SessionId, SessionRecord>()
  const bySession = new WeakMap<Agent, SessionId>()
  // Reserve ids across asynchronous resume; distinct ids still load concurrently.
  const loadingIds = new Set<SessionId>()
  // Post-await checks prevent a closing bridge from publishing resumed sessions.
  let closed = false
  // Connection-level capability copied into each new session record.
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
    // sessionUpdate returns a promise; a closed connection rejects it. The
    // update is best-effort UI feed, never load-bearing for correctness, so a
    // throwing/rejecting send must not break the turn (the chunk is emitted
    // inside the model step — see docs/defensive-patterns.md "contain callback exceptions").
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

  // All content streaming AND the prompt settle flow through `session/event`,
  // the canonical log: every assistant/chunk and tool/call/result is logged, so
  // translating from the log makes live streaming and `session/load` replay
  // share the identical path (streamSessionEventUpdate). Both the owning-turn
  // capture and the settle key off the log's own `turn/start`/`turn/end` — the
  // durable boundary events (there is no agent/* turn mirror). `closeTurn`
  // appends `turn/end` to the log unconditionally, and `turn/start` is appended
  // before any step runs, so within this one listener we always see the
  // prompt's turn-start (tag `inflight.turn`) then its turn-end (settle). A
  // `turn/end` settles the prompt ONLY when it is the prompt's OWN turn
  // (`inflight.turn === event.data.turn`) — a previous, already-cancelled turn
  // whose end arrives late is ignored (see
  // SessionRecord.inflight). A turn that ends `error` REJECTS the prompt (ACP
  // has no error stop reason); other reasons resolve via the codec. Demux
  // strictly by session id: a `session/event` is routed to its own record, so
  // two sessions streaming at once never cross-settle or interleave updates.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const rec = sessions.get(session.header.id)
    if (rec === undefined) return
    try {
      streamSessionEventUpdate(rec.sessionId, event, notify, rec.presenter, {
        enabled: rec.terminalEnabled,
        cwd: session.header.cwd,
      }, { includeUserMessages: false })
    } finally {
      const inflight = rec.inflight
      if (inflight !== undefined && event.type === 'turn/start') {
        // The first message-triggered turn after prompt installation owns the
        // prompt; injection-triggered turns must not settle it early.
        if (inflight.turn === undefined && event.data.trigger.kind === 'message') {
          inflight.turn = event.data.turn
        }
      } else if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        rec.inflight = undefined
        settleFromTurnEnd(inflight, event.data.reason)
      }
    }
  })

  // --- Approval answerer -----------------------------------------------------
  // The bridge is the approval channel for the agents it owns: an `ask` routed
  // through `ctx.approval` (dsh-tools asks and sandbox escalation) becomes
  // an editor permission prompt attached to the already-streamed tool call. The
  // listener occupies the single decision slot ONLY for its own agents — a
  // foreign or call-less request delegates via next() so another answerer (or
  // the fail-closed `unavailable` default) takes the question. A rejected
  // `requestPermission` (client gone, bridge torn down) propagates and the
  // ApprovalService contains it as `unavailable`. Options are one-shot only:
  // allow_always is a grant-storage design the approval RFC defers, so the
  // prompt never offers a durable grant the harness could not honor.
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
   * Build the single Permissions option when `ctx.permission` is composed.
   * Its value comes from the session log, overlaid by an unanchored idle
   * switch, so `session/load` needs no catch-up state.
   */
  const configOptionsFor = (agent: Agent, pending: SessionRecord['pendingSwitches'] = {}): SessionConfigOption[] => {
    const presets = ctx.get('permission')
    if (presets === undefined) return []
    const currentValue = pending.preset ?? presets.current(agent.session.events)
    return [{
      id: 'permission',
      name: 'Permissions',
      description: 'Sets this session\'s sandbox and approval behavior.',
      category: 'mode',
      type: 'select',
      currentValue,
      options: [
        ...presets.names.map((name: string) => presets.optionOf(name)),
        // `custom` is offered only as the current-value echo, never as a target.
        ...currentValue === 'custom' ? [presets.optionOf('custom')] : [],
      ],
    }]
  }

  /**
   * Whether the session's log currently has an open turn — the last boundary
   * event is a `turn/start`. Decides whether a config switch may append NOW
   * (enclosed) or must wait for the next prompt submission (see
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
   * Anchor a pending preset in the open turn. `PermissionService.set()` skips
   * net-zero changes, so the log records switches rather than select clicks.
   */
  const flushPendingSwitches = (rec: SessionRecord): void => {
    const pending = rec.pendingSwitches
    rec.pendingSwitches = {}
    if (pending.preset === undefined) return
    const presets = ctx.get('permission')
    /* v8 ignore next -- a pending preset exists only if the service answered the
       switch; a valid composition cannot unmount it before anchoring. */
    if (presets === undefined) return
    presets.set(rec.agent.session, pending.preset)
  }

  // Anchor idle switches on the next prompt submission: its turn is open, but
  // request assembly has not begun. This handler runs outside log emission, so
  // invariants and persistence observe the events in log order; the first flush
  // clears pending state. Promptless injection turns leave the switch pending,
  // with no request or execution under stale settings.
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
        // Creation awaits the unpublished setup transaction. A client disconnect
        // can therefore close this bridge
        // after the entry check but before the handle resolves; never install a
        // post-close record that quiesce() could not have seen.
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
        // Reserve THIS id's load slot BEFORE the await. Without it, two pipelined
        // loads for the same id could both pass the guard above while the first
        // resume() is pending, then both install a record and leak a second
        // agent. (Distinct ids load concurrently — the set is keyed by id.) The
        // slot is released in `finally` so a rejected load never wedges the id.
        loadingIds.add(sessionId)
        try {
          // Validate the PERSISTED cwd BEFORE resuming — `list()` is a
          // metadata-only read (no full-log parse), so this rejects a session we
          // can't honor WITHOUT ever constructing/registering an agent (a
          // post-resume reject would leak the registered agent — cancel() does not
          // unregister it — and wedge the id against re-load). The session's bash
          // workdir is derived from its persisted `header.cwd` and the request
          // `cwd` does NOT override it (resume takes no cwd), so a session with no
          // absolute persisted cwd would silently run bash in the SERVER's launch
          // dir, not the client's workspace. A session created by this bridge
          // always has a cwd (session/new requires it); reject the rest loudly.
          // (An id unknown to `list()` falls through to resume, which rejects with
          // the backend's not-found error.)
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
          // The bridge may have torn down (disposal / client disconnect) while
          // resume() was pending. Its listeners are gone, so installing a record
          // now would resurrect a live agent the bridge can no longer drive. Bail —
          // and tear down the just-resumed agent (unregister + stop + remove its
          // session) before throwing, so it does not leak: it has no SessionRecord,
          // so quiesce() would never see it.
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
          // Replay the persisted event log to the client as session/update. Use
          // the raw event log (NOT deriveMessages, which drops assistant/chunk
          // and trace events): RFC 010's load contract reconstructs the streamed
          // turns — user prompts (user/message → user_message_chunk), assistant
          // text and reasoning (assistant/chunk), and tool calls/results.
          //
          // Replay through a THROWAWAY presenter, NOT `record.presenter`: a
          // historical turn that was interrupted mid-tool (a `tool/call` with no
          // matching `tool/result` in the persisted log) would otherwise leave a
          // stale in-flight entry on the live presenter, which then serves all
          // future live events for this session. The throwaway pairs call→result
          // as the log replays in order (same as live) and is discarded after,
          // so the record's presenter starts clean for the post-load live stream.
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
        // Install the in-flight slot BEFORE send() (send does not synchronously
        // flip status to running; the session/event listener records the turn
        // number and settle/rejects it). Capture the log length now as the
        // A turn that ends in error rejects this promise (the codec never
        // produces an error stop reason).
        const stopReason = await new Promise<StopReason>((resolve, reject) => {
          rec.inflight = { resolve, reject, turn: undefined }
          rec.agent.send([{ type: 'text', text }])
        })
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const rec = sessions.get(SessionId(params.sessionId))
        if (rec === undefined) return Promise.resolve()
        // session/cancel maps to the queue-aware agent.cancel(reason): it aborts
        // a RUNNING step, clears the queued + steering FIFOs, and drops a
        // turn that is about to start (the pre-step window) — so a queued-but-
        // not-yet-started prompt never runs, and a prompt accepted right after
        // cannot be batched into the cancelled turn. Scoped to THIS session's
        // agent — a cancel in one session never touches another's stream or
        // pending prompt (RFC 011 isolation). We ALSO settle the in-flight prompt
        // as cancelled directly here: do NOT rely on the resulting turn/end to
        // settle it, because cancel() may drop the turn before any turn/end is
        // emitted, and removing this direct settle would move the RPC's
        // resolution onto a later observer path, changing its timing.
        rec.agent.cancel('session/cancel')
        settlePrompt(rec, 'cancelled')
        return Promise.resolve()
      },

      setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const rec = requireSession(SessionId(params.sessionId))
        // The advertised option is a select, so the boolean-shaped variant of
        // the request is a protocol misuse regardless of configId.
        if (typeof params.value !== 'string') {
          throw invalidParams(`config option ${params.configId} is a select; boolean values are not accepted`)
        }
        // Open-turn switches append immediately; idle switches wait for the
        // next prompt-submit. Only values advertised by this composition are
        // accepted, and the session log remains the durable store.
        switch (params.configId) {
          case 'permission': {
            const presets = ctx.get('permission')
            if (presets === undefined) {
              throw invalidParams(`unknown permission value ${JSON.stringify(params.value)}`)
            }
            // Clients may re-send the current selection on session start. Accept
            // that echo without logging; this is the only valid `custom` request.
            const current = rec.pendingSwitches.preset ?? presets.current(rec.agent.session.events)
            if (params.value === current) break
            if (!presets.names.includes(params.value)) {
              throw invalidParams(`unknown permission value ${JSON.stringify(params.value)}`)
            }
            if (isTurnOpen(rec.agent)) presets.set(rec.agent.session, params.value)
            else rec.pendingSwitches.preset = params.value
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

  // The transport stream. Production wires stdio (stdout carries the protocol);
  // tests inject an in-memory pipe pair via config.stream to drive the bridge
  // without a subprocess. ndJsonStream is the SDK's stdio framing helper. The
  // AgentSideConnection constructor synchronously invokes makeAgent (assigning
  // the outer `conn`), so `conn` is set before any agent method runs.
  /* v8 ignore next 4 -- production stdio wiring; tests always inject config.stream */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  /**
   * Tear ALL live sessions down to quiescence (docs/defensive-patterns.md "dispose must reach
   * quiescence"): for each session settle any pending prompt `cancelled`, then
   * run that session's {@link AgentHandle} `dispose()` — which stops the loop
   * (sets `disposed`, aborts the in-flight step), AWAITS the loop's exit (the
   * final `turn/end` + `session/flush` are captured while the store-owned publication hooks are still
   * attached), unregisters the agent, and removes its session from the store.
   * The per-session disposes run in parallel. Idempotent — clears the `sessions`
   * map first and memoizes, so a second call (close racing dispose) is a no-op.
   * Shared by Cordis disposal AND client disconnect (`conn.closed`).
   *
   * Per-agent disposal closes the queued-before-run window through the DISPOSED
   * path, not `cancel()`: the start-disposer resolves `handle.disposed`, which
   * wakes the parked loop, and `isDisposed()` breaks the loop before a
   * queued-but-not-yet-running turn can start (a turn cut off mid-flight ends
   * with reason `disposed`, not `aborted`). A bare client disconnect (resolves
   * `conn.closed` WITHOUT disposing the fiber) thus leaves NO registered agent
   * and NO session-store entry — not an idled-but-still-registered one. When the
   * fiber IS disposed (whole-context or an ACP-only HMR
   * `acpFiber.dispose()`), this same memoized teardown runs first; the factory's
   * register+start+session effects are ALSO bound to the bridge fiber (the
   * factory is reached through this bridge's traceable service proxy, so
   * `AgentLoop.start`'s `this.ctx.effect(...)` binds to the CALLER context — the
   * bridge fiber), so any agent this path did not reach is still reclaimed by
   * fiber disposal.
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

  // Client disconnect: when the ACP transport closes (editor quits, pipe EOF),
  // the in-flight turn would otherwise keep running and its `session/update`
  // writes would be silently swallowed by `notify()`. Tear the session down so
  // a vanished client does not leave an orphaned running agent. `conn.closed`
  // rejects/resolves once; contain any teardown throw (nothing else can act on
  // it — the connection is already gone). The Cordis disposer below still runs
  // on normal shutdown and is idempotent with this.
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
 * Validate the `cwd`/`additionalDirectories` contract shared by `session/new`
 * and `session/load`: `cwd` must be absolute (a relative path would be ambiguous
 * as a workspace root). The persisted-cwd equality check for `session/load`
 * happens after the metadata lookup; this validator only enforces request shape:
 *  - `session/new`: the validated `cwd` becomes the session's `SessionHeader.cwd`
 *    (via `agents.create({meta:{cwd}})`) and thus the default bash workdir.
 *  - `session/load`: the request `cwd` must be absolute AND must match the
 *    PERSISTED `header.cwd`, which stays authoritative for the bash workdir —
 *    the request cwd does not override it.
 * Any absolute path is accepted (the per-session cwd flows to the bash executor
 * — see `dsh-tool-bash`), so the server no longer has to launch in the
 * workspace. `additionalDirectories` must still be empty: widening the
 * tool/filesystem scope beyond the single cwd is a separate, unimplemented
 * concern (a sandbox seam), and silently ignoring extra roots would desync the
 * client's filesystem-scope UI. Both request shapes carry `cwd: string` and
 * `additionalDirectories?: string[]`, so one validator covers both.
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
 * Translate a single harness {@link SessionEvent} into the `session/update`
 * notification(s) it produces, pushing each via `notify`. Shared by live
 * streaming (`session/event`) and `session/load` replay so both paths emit an
 * identical update stream from the same event log.
 *
 * - `assistant/chunk` text-delta/reasoning-delta → message/thought chunks
 * - `user/message` → `user_message_chunk` during load replay only — so a
 *   loaded transcript reconstructs the USER side of each turn without echoing
 *   a live `session/prompt` back to the client
 * - `tool/call`   → `tool_call` (pending)
 * - `tool/result` → `tool_call_update` (completed/failed)
 *
 * Tool-call presentation (title/kind/rawInput, and the completed-state content)
 * is owned by each TOOL via `presentCall`/`presentResult` — the bridge never
 * special-cases tool names. `presenter` resolves those from the tool registry
 * and remembers each call's `(name, args)` so the completed `tool/result` (which
 * carries neither) can find its tool. A {@link nullToolPresenter} gives the
 * generic fallback (title = tool name, raw args as input) when no registry is
 * available (e.g. pure translator tests).
 *
 * Other event types (turn/step boundaries, context/message, …) produce
 * no client update.
 * @param sessionId - the ACP session id stamped on every emitted notification.
 * @param event - the harness session event to translate.
 * @param notify - sink for each produced `session/update` notification; called
 * zero or more times per event (best-effort UI feed, never load-bearing).
 * @param presenter - resolves tool-owned render intent for tool events;
 * defaults to the generic-fallback {@link nullToolPresenter}.
 * @param terminal - the connection's terminal-rendering context; defaults to
 * disabled (the plain-text console-block fallback).
 * @param options - `includeUserMessages` (default `true`): live streaming
 * passes `false` so a prompt the client just sent is not echoed back.
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
 * Map a whole harness todo list to an ACP plan, assigning medium priority.
 * Statuses map directly and ACP replaces its whole plan on each update.
 * @param todos - the harness todo list (the whole list, not a diff).
 * @returns the ACP plan body, one entry per todo.
 */
export function todosToPlan(todos: TodoItem[]): Plan {
  return { entries: todos.map((todo): PlanEntry => ({ content: todo.content, priority: 'medium', status: todo.status })) }
}

/** Terminal-card capability and workspace context for event rendering. */
export interface TerminalRendering {
  enabled: boolean
  /** The session workspace cwd (terminal-card header default); `undefined` when the session has none. */
  cwd: string | undefined
}

/** Default: terminal rendering off (the ` ```console ` text fallback path). */
const noTerminalRendering: TerminalRendering = { enabled: false, cwd: undefined }

/**
 * Resolve tool-owned call/result views with generic fallbacks. Per-session
 * call-id state supplies the tool name and arguments omitted from result events.
 * Each entry is consumed by its result; any remainder dies with the session.
 */
export class ToolPresenter {
  private readonly pending = new Map<CallId, { name: string; args: unknown; card: ToolCallView['card'] }>()

  /**
   * @param tools the registry to resolve tool definitions by name.
   * @param onError receives contained presenter failures before generic fallback.
   */
  constructor(
    private readonly tools: Pick<ToolRegistry, 'get'>,
    private readonly onError: (message: string) => void = () => {},
    /** Agent scope for tool lookup; absent during replay without a live agent. */
    private readonly agent?: Agent,
  ) {}

  /**
   * Resolve a pending call and remember its state for the matching result.
   * @param callId - the call id the matching `tool/result` will look up.
   * @param name - the tool name, resolved against the registry for `presentCall`.
   * @param argsJson - the raw arguments JSON from the event; parsed for the view
   * (a non-JSON string is surfaced raw).
   * @returns the tool-owned view, or a generic parsed-input fallback.
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
    // No tool-owned presentation: fall back to the tool name as the title, the
    // full parsed args as the raw input, and kind `other` (the generic card).
    // The kind is never sniffed from the name — the bridge does not special-case
    // tool names; a tool that wants a richer kind declares `presentCall`.
    const view: ToolCallView = present ?? { card: 'generic', title: name, kind: 'other', rawInput: args }
    this.pending.set(callId, { name, args, card: view.card })
    return view
  }

  /**
   * Resolve a completed result and consume its remembered call state.
   * @param callId - matching call id; unknown or late ids use raw content.
   * @param content - the result's content blocks (the fallback and fill-in body).
   * @param isError - whether the result is an error, forwarded to `presentResult`.
   * @param meta - the result's machine-readable meta, forwarded when present.
   * @returns the normalized tool-owned view, or a raw-content generic fallback.
   */
  result(callId: CallId, content: ContentBlock[], isError: boolean, meta?: unknown): ToolResultView {
    const call = this.pending.get(callId)
    this.pending.delete(callId)
    // No remembered call (unknown/late callId) → nothing to present from; raw content.
    if (call === undefined) return { card: 'generic', content }
    let present: ToolResultView | undefined
    try {
      present = this.tools.get(call.name, this.agent)
        ?.presentResult?.(call.args, { content, isError, ...meta !== undefined ? { meta } : {} })
    } catch (error: unknown) {
      // A throwing presentResult must not break streaming/replay: log + fall back.
      this.onError(`acp: tool "${call.name}" presentResult threw, using raw result: ${String(error)}`)
      present = undefined
    }
    if (present === undefined) return { card: 'generic', content }
    // Orphan guard: only honor a `terminal` result when the PENDING call was a
    // terminal. A result-only terminal with no matching call-side terminal would
    // orphan `_meta.terminal_output` to a terminal Zed never made — drop it back
    // to the raw content.
    if (present.card === 'terminal' && call.card !== 'terminal') return { card: 'generic', content }
    // A generic result that reformats no content keeps the RAW result content
    // (the tool replaced only the title); fill it so the card is never blanked.
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

/** Relativize an in-workspace file path in a card title; keep target paths raw. */
function displayTitle(title: string, rawPath: string | undefined, sessionCwd: string | undefined): string {
  if (rawPath === undefined || sessionCwd === undefined || !isAbsolute(rawPath) || !isAbsolute(sessionCwd)) return title
  const rel = relativePath(sessionCwd, rawPath)
  // Reject an empty relative path or a leading parent-directory segment.
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
      // A terminal-rendered call gets a terminal CARD when the client supports it:
      // the description renders ABOVE the card, then the terminal block, plus
      // `_meta.terminal_info` (the cwd header). Without the capability it is an
      // ordinary execute card whose body is the description and whose rawInput is
      // the command; the output arrives as text on the result.
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
 * Build the `tool_call_update` (completed) `session/update` from a result render
 * intent. A `generic` result sends its reformatted content (or the raw result);
 * a `terminal` result rides its output/exit on `_meta` when the client is capable
 * (the terminal card consumes them and `content` is OMITTED — a
 * `tool_call_update.content` REPLACES the call's content collection in Zed, so
 * re-sending would clobber the terminal block the call installed) and otherwise
 * derives the fenced ```console fallback from `output`. A `diff` result emits its
 * `{ type: 'diff' }` content blocks (an applied hunk, or a whole-file diff for a
 * create), which replace the diff the call installed — so the model-facing result
 * text can never clobber it.
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
      // A result-time diff: emit one `{ type: 'diff' }` content block per entry
      // (an applied hunk for an edit/overwrite, or a whole-file diff for a
      // create), mirroring the call-side diff arm. `tool_call_update.content`
      // REPLACES the call's content in an editor, so this result diff supersedes
      // the diff the pending card installed (and keeps the model-facing result
      // text from clobbering it).
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
