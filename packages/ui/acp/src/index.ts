/**
 * Multi-session ACP bridge over JSON-RPC stdio. Creates or resumes agents,
 * routes session-scoped events and approvals, and settles prompts by turn.
 * Stdout is reserved for protocol frames.
 *
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
  type AnyMessage,
  type AuthenticateRequest,
  type AvailableCommand,
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
  type SessionModeState,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type Stream,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { ContentBlock, LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { assertNever, CallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import {
  installAgentLlmTarget,
  type Agent,
  type AgentLlmTarget as LlmTarget,
  type AgentLlmTargetRef as LlmTargetRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: resolves `ctx.get('permission')` to the service.
import type {} from '@deepseek-ai/dsh-permission'
import type { SessionEvent, TodoItem, TurnEndReason } from '@deepseek-ai/dsh-session'
// Side-effect type import: adds the log-only session/title event translated below.
import type {} from '@deepseek-ai/dsh-session-title'
import type { ToolCallView, ToolRegistry, ToolResultView, TerminalResultView } from '@deepseek-ai/dsh-tools'
// Side-effect type import: declaration-merges `ctx.sessionPersistence` onto
// Context (the bridge injects it and reads `list()` for load cwd validation).
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only edge: resolves `ctx.get('planMode')` when dsh-plan-mode is composed;
// the runtime read stays opportunistic.
import type {} from '@deepseek-ai/dsh-plan-mode'
// Side-effect type import: declaration-merges prompt assembly onto Context and
// the scoped waterfall used to keep persona variables aligned with requests.
import type {} from '@deepseek-ai/dsh-system-prompt'
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
// Interface services back loading, presentation, interaction, and prompt assembly.
export const inject = ['agents', 'commands', 'sessionPersistence', 'tools', 'userInteraction', 'llm', 'systemPrompt']

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

const DEFAULT_SESSION_MODE_ID = 'default'
const PLAN_SESSION_MODE_ID = 'plan'
const AVAILABLE_SESSION_MODES = [
  { id: DEFAULT_SESSION_MODE_ID, name: DEFAULT_SESSION_MODE_ID },
  { id: PLAN_SESSION_MODE_ID, name: PLAN_SESSION_MODE_ID },
]

/** Map plan state onto ACP's named collaboration-mode protocol. */
function sessionModeId(active: boolean): string {
  return active ? PLAN_SESSION_MODE_ID : DEFAULT_SESSION_MODE_ID
}

/** Render arbitrary thrown values without trusting their string coercion. */
function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/** Return a server-created session id carried by an outbound success response. */
function responseSessionId(message: AnyMessage): SessionId | undefined {
  if (!('result' in message) || typeof message.result !== 'object' || message.result === null
    || !('sessionId' in message.result) || typeof message.result.sessionId !== 'string') {
    return undefined
  }
  return SessionId(message.result.sessionId)
}

/** Observe messages only after the wrapped ACP transport has written them. */
function observeOutbound(stream: Stream, onWritten: (message: AnyMessage) => void): Stream {
  const writer = stream.writable.getWriter()
  return {
    readable: stream.readable,
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        await writer.write(message)
        onWritten(message)
      },
      /* v8 ignore start -- the ACP SDK never closes or aborts its outbound stream;
         preserve the wrapped Stream contract for other consumers nonetheless */
      close: () => writer.close(),
      abort: (reason: unknown) => writer.abort(reason),
      /* v8 ignore stop */
    }),
  }
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
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
  const message = question.detail === undefined
    ? question.question
    : `${question.question}\n\n${question.detail}`
  if (options.length === 0) {
    return {
      sessionId,
      mode: 'form',
      message,
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
    message,
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
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents (must have a registered adapter). */
  model?: string
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
})

/** One resolved ACP model selector plus its opaque value lookup. */
interface ModelDirectory {
  option: Extract<SessionConfigOption, { type: 'select' }> | undefined
  targets: ReadonlyMap<string, LlmTarget>
}

/** One provider and its adapter-advertised models, detached for one RPC. */
interface ModelCatalogEntry {
  provider: LlmProviderInfo
  models: LlmModelInfo[]
}

/** Per-session bridge state keyed by ACP session id. */
interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /** Per-session tool presentation and call/result correlation. */
  presenter: ToolPresenter
  /** Terminal capability snapshot shared by matching call and result updates. */
  terminalEnabled: boolean
  /**
   * The last mode id this session sent to the client (advertised at
   * session/new+load, echoed optimistically on session/set_mode, re-notified on
   * each logged `plan/mode` that differs). `undefined` when dsh-plan-mode is
   * not composed, so no mode surface is advertised or notified.
   */
  lastModeId: string | undefined
  /** Session-local provider/model selection and the current step snapshot. */
  target: LlmTargetRef
  /** In-flight prompt and its captured turn number for exact settlement. */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    turn: number | undefined
  } | undefined
  /** Abort owner for a direct slash-command request, mutually exclusive with `inflight`. */
  commandAbort: AbortController | undefined
  /** Last idle switch per knob, anchored before the next prompt assembles. */
  pendingSwitches: { preset?: string }
}

/**
 * Drive the in-flight prompt's settle from the harness event stream. The bridge
 * settles off the durable `turn/end` event for the prompt's own turn. Session
 * contains post-commit observers independently, and this listener performs
 * correlation in a `finally` so presentation failure cannot starve settlement.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture
  // injected services during apply(); lazy service reads in a handler fail.
  const agents = ctx.agents
  const commands = ctx.commands
  const llm = ctx.llm
  const sessionPersistence = ctx.sessionPersistence
  const logger = ctx.logger
  const tools = ctx.tools
  const userInteraction = ctx.userInteraction
  // Presenter callbacks are contained so display failures cannot break protocol handling.
  const makePresenter = (agent?: Agent): ToolPresenter => new ToolPresenter(tools, (message) => { logger.warn(message) }, agent)

  /** Resolve a complete target only; partial config remains available to other request listeners. */
  const configuredTarget = (): LlmTarget | undefined => config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : undefined

  /** Install the ACP target as an agent-scoped prompt/request override. */
  const installTarget = (agentCtx: Context, target: LlmTargetRef): void => {
    const agent = agentCtx.agent
    /* v8 ignore next -- setup is invoked only with the freshly created agent's scoped context. */
    if (agent === undefined) throw new Error('acp: agent setup has no scoped agent')
    const logged = agent.session.requestHeader()?.config
    if (logged !== undefined) target.current = { provider: logged.provider, model: logged.model }

    installAgentLlmTarget(agentCtx, target)
  }

  /** Opaque ACP value preserving both routing dimensions. */
  const targetValue = (target: LlmTarget): string => JSON.stringify([target.provider, target.model])

  /** Read one detached advisory catalog snapshot before mutating session state. */
  const readModelCatalog = async (): Promise<ModelCatalogEntry[]> => Promise.all(
    llm.listProviders().map(async provider => ({
      provider,
      models: await llm.listModels(provider.id),
    })),
  )

  /** Resolve one catalog snapshot into the ACP model selector for a session. */
  const modelDirectory = (catalog: readonly ModelCatalogEntry[], current: LlmTarget | undefined): ModelDirectory => {
    if (current === undefined) return { option: undefined, targets: new Map() }
    const models = catalog.map(entry => ({ provider: entry.provider, models: [...entry.models] }))
    const currentProvider = models.find(entry => entry.provider.id === current.provider)
    if (currentProvider === undefined) return { option: undefined, targets: new Map() }
    if (!currentProvider.models.some(model => model.id === current.model)) {
      currentProvider.models = [...currentProvider.models, {
        provider: current.provider,
        id: current.model,
        name: current.model,
      }]
    }

    const targets = new Map<string, LlmTarget>()
    const groups = models.flatMap(({ provider, models: entries }) => {
      if (entries.length === 0) return []
      const options = entries.map((model): SessionConfigSelectOption => {
        const target = { provider: model.provider, model: model.id }
        const value = targetValue(target)
        targets.set(value, target)
        return {
          value,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
        }
      })
      return [{ group: provider.id, name: provider.name, options } satisfies SessionConfigSelectGroup]
    })
    return {
      option: {
        id: 'model',
        name: 'Model',
        description: 'Sets this session\'s provider and model.',
        category: 'model',
        type: 'select',
        currentValue: targetValue(current),
        options: groups.length === 1 ? groups.flatMap(group => group.options) : groups,
      },
      targets,
    }
  }

  const sessions = new Map<SessionId, SessionRecord>()
  // Reserve an id before resume so pipelined load/new requests cannot duplicate it.
  const loadingIds = new Set<SessionId>()
  // A new-session response introduces its server-generated id to the client;
  // keep its initial command snapshot pending until that response is written.
  const pendingCommandSnapshots = new Map<SessionId, SessionRecord>()
  // Async creation checks this after awaits to avoid publishing after teardown.
  let closed = false
  // Each new or loaded session snapshots the latest connection capability.
  let terminalOutputCap = false

  // Assigned at the bottom, before any agent event can fire (a session only
  // exists after `newSession`, which the client calls after construction), so
  // `notify` never observes it unset — no undefined guard needed.
  let conn: AgentSideConnection

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const rec = sessions.get(agent.session.id)
    return rec?.agent === agent ? rec : undefined
  }

  userInteraction.registerProvider({
    async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
      if (request.agent === undefined) {
        throw new UserInteractionError('ACP user questions must come from an agent-owned request', 'NO_AGENT')
      }
      const rec = ownedRecord(request.agent)
      if (rec === undefined) {
        throw new UserInteractionError('ACP user question has no matching session', 'NO_SESSION')
      }
      const answers: AskUserQuestionAnswerItem[] = []
      for (const question of request.questions) {
        const options = question.options ?? []
        const response = await withAbort(conn.unstable_createElicitation(
          elicitationForQuestion(rec.agent.session.id, question, options),
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

  /** Project the effective registry view onto ACP discovery metadata. */
  const availableCommands = (agent: Agent): AvailableCommand[] => commands.list(agent).map(command => ({
    name: command.name,
    description: command.description,
    ...command.input === undefined ? {} : { input: { hint: command.input.hint } },
  }))

  /** Push the protocol's full-snapshot command catalog for one live session. */
  const notifyCommands = (rec: SessionRecord): void => {
    notify({
      sessionId: rec.agent.session.id,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: availableCommands(rec.agent),
      },
    })
  }

  /** Enqueue a new session's first command snapshot behind its written RPC response. */
  const announceInitialCommands = (message: AnyMessage): void => {
    const sessionId = responseSessionId(message)
    if (sessionId === undefined) return
    const rec = pendingCommandSnapshots.get(sessionId)
    if (rec === undefined) return
    pendingCommandSnapshots.delete(sessionId)
    notifyCommands(rec)
  }

  // Registration and HMR removal can affect global or one scoped view; refresh
  // every announced bridge-owned session and let the registry resolve each
  // exact agent. A pending new-session snapshot will read the latest registry.
  ctx.on('commands/change', () => {
    for (const rec of sessions.values()) {
      if (!pendingCommandSnapshots.has(rec.agent.session.id)) notifyCommands(rec)
    }
  })

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
      inflight.reject(internalError(`turn failed: ${'failure' in reason ? reason.failure.message : reason.message}`))
    } else {
      inflight.resolve(turnEndToStopReason(reason))
    }
  }

  // --- Stream the harness event taxonomy to ACP session/update --------------

  // --- Session modes (dsh-plan-mode, opportunistic) -------------------------
  // ACP's generic mode picker projects the one plan capability as the fixed
  // `default` / `plan` vocabulary. A selection is echoed optimistically; the
  // logged `plan/mode` follows at the boundary and tool-driven exits are
  // re-notified from that event. Environment knobs remain config options.
  const modesStateFor = (agent: Agent): SessionModeState | undefined => {
    const planMode = ctx.get('planMode')
    if (planMode === undefined) return undefined
    const { active, pending } = planMode.get(agent)
    return {
      availableModes: AVAILABLE_SESSION_MODES,
      currentModeId: sessionModeId(pending ?? active),
    }
  }

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
  // strictly by session id: concurrent updates may alternate on the shared
  // connection, but they retain the owning id and never cross-settle.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const rec = sessions.get(session.header.id)
    if (rec === undefined) return
    try {
      streamSessionEventUpdate(rec.agent.session.id, event, notify, rec.presenter, {
        enabled: rec.terminalEnabled,
        cwd: session.header.cwd,
      }, { includeUserMessages: false })
    } finally {
      // Re-notify from the EVENT's value, not from planMode.get(): the service
      // holds one coalesced pending slot (every flush reads the latest
      // selection, so a flush can never be stale against the picker), and for
      // any other writer — the exit tool, a test, a foreign plugin — the logged
      // value IS the truth the picker should track, in log order. Inside the
      // containment `finally` like the prompt settlement: a throwing presenter
      // must not desync the picker.
      if (event.type === 'plan/mode') {
        const modeId = sessionModeId(event.data.active)
        if (modeId !== rec.lastModeId) {
          rec.lastModeId = modeId
          notify({ sessionId: rec.agent.session.id, update: { sessionUpdate: 'current_mode_update', currentModeId: modeId } })
        }
      }
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
  // allow_always is a grant-storage design the approval Agent Note defers, so the
  // prompt never offers a durable grant the harness could not honor.
  ctx.on('approval/request', (req, next) => {
    const rec = ownedRecord(req.agent)
    // The protocol requires `toolCall` (the prompt renders attached to it), so
    // a request without a callId has nothing to attach to — delegate.
    if (rec === undefined || req.callId === undefined) return next()
    return conn.requestPermission({
      sessionId: rec.agent.session.id,
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

  /** Build every ACP session option from the model directory and live services. */
  const configOptionsFor = (
    agent: Agent,
    directory: ModelDirectory,
    pending: SessionRecord['pendingSwitches'] = {},
  ): SessionConfigOption[] => {
    const options = directory.option === undefined ? [] : [directory.option]
    const presets = ctx.get('permission')
    if (presets === undefined) return options
    const currentValue = pending.preset ?? presets.current(agent.session.events)
    return [...options, {
      id: 'permission',
      name: 'Permissions',
      description: 'The session permission preset: each choice bundles a sandbox mode and an approval policy.',
      category: 'mode',
      type: 'select',
      currentValue,
      options: [
        ...presets.names.map((name: string) => presets.optionOf(name)),
        // `custom` echoes the current derived state but is never a target.
        ...currentValue === 'custom' ? [presets.optionOf('custom')] : [],
      ],
    }]
  }

  /** Whether the log has an open turn in which a config switch can be enclosed. */
  const isTurnOpen = (agent: Agent): boolean => {
    const events = agent.session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = (events[index] as SessionEvent).type
      if (type === 'turn/start') return true
      if (type === 'turn/end') return false
    }
    return false
  }

  /** Anchor last-write-wins idle switches into a just-opened turn. */
  const flushPendingSwitches = (rec: SessionRecord): void => {
    const pending = rec.pendingSwitches
    rec.pendingSwitches = {}
    if (pending.preset === undefined) return
    const presets = ctx.get('permission')
    /* v8 ignore next -- a pending preset exists only if the service answered the
       switch; it cannot unmount between that and the next turn in any composition. */
    if (presets === undefined) return
    presets.set(rec.agent.session, pending.preset)
  }

  // Prompt-submit is inside the new turn but before prompt assembly. Promptless
  // injection turns leave the switch pending because they execute no request.
  ctx.on('agent/prompt-submit', (agent, _content, _source, _signal, next) => {
    const rec = ownedRecord(agent)
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
        // + the terminal-rendering Agent Note). `_meta` is `{[k]: unknown} | null`, so
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
        const target: LlmTargetRef = { current: configuredTarget(), assembled: undefined }
        const directory = modelDirectory(await readModelCatalog(), target.current)
        assertOpen()
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
          setup: (agentCtx) => { installTarget(agentCtx, target) },
        })
        // Agent creation may resolve after the bridge closes; dispose the handle
        // instead of publishing a record that teardown could not observe.
        /* v8 ignore next 4 -- the in-memory transport rejects the in-flight RPC
           immediately on close; real stdio may let the handler resume */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const modes = modesStateFor(handle.agent)
        const record: SessionRecord = {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          presenter: makePresenter(handle.agent),
          terminalEnabled: terminalOutputCap,
          lastModeId: modes?.currentModeId,
          target,
          inflight: undefined,
          commandAbort: undefined,
          pendingSwitches: {},
        }
        sessions.set(sessionId, record)
        pendingCommandSnapshots.set(sessionId, record)
        const configOptions = configOptionsFor(handle.agent, directory)
        return {
          sessionId,
          ...modes !== undefined ? { modes } : {},
          ...configOptions.length > 0 ? { configOptions } : {},
        }
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
          const catalog = await readModelCatalog()
          assertOpen()
          const target: LlmTargetRef = { current: configuredTarget(), assembled: undefined }
          const handle = await agents.resume({
            resumeSessionId: sessionId,
            agentOptions: agentOptions(config),
            setup: (agentCtx) => { installTarget(agentCtx, target) },
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
          const directory = modelDirectory(catalog, target.current)
          const agent = handle.agent
          // Snapshot the terminal capability ONCE for this session (used by both
          // the replay below and the post-load live stream) so a later
          // `initialize` can't desync the call/result of a tool card.
          const terminalEnabled = terminalOutputCap
          const modes = modesStateFor(agent)
          const record: SessionRecord = {
            agent,
            dispose: () => handle.dispose(),
            presenter: makePresenter(agent),
            terminalEnabled,
            lastModeId: modes?.currentModeId,
            target,
            inflight: undefined,
            commandAbort: undefined,
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
          notifyCommands(record)
          const configOptions = configOptionsFor(agent, directory)
          return {
            ...modes !== undefined ? { modes } : {},
            ...configOptions.length > 0 ? { configOptions } : {},
          }
        } finally {
          loadingIds.delete(sessionId)
        }
      },

      setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
        assertOpen()
        const rec = requireSession(SessionId(params.sessionId))
        const planMode = ctx.get('planMode')
        if (planMode === undefined) throw invalidParams('session modes are not composed in this deployment')
        if (params.modeId !== DEFAULT_SESSION_MODE_ID && params.modeId !== PLAN_SESSION_MODE_ID) {
          throw invalidParams(`unknown session mode ${JSON.stringify(params.modeId)} — available modes: default, plan`)
        }
        planMode.set(rec.agent, params.modeId === PLAN_SESSION_MODE_ID)
        // Optimistic echo: the pending mode IS the user's selection; the logged
        // `plan/mode` lands at the next turn boundary and, matching lastModeId,
        // is not re-notified. A no-op selection (already current) echoes too —
        // cheap, idempotent, and the picker settles regardless.
        rec.lastModeId = params.modeId
        notify({ sessionId: rec.agent.session.id, update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId } })
        return Promise.resolve({})
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const rec = requireSession(SessionId(params.sessionId))
        if (rec.inflight !== undefined || rec.commandAbort !== undefined) {
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
        // ACP command prompts may carry additional supported content blocks.
        // The same lossless flattening used for model prompts supplies their
        // unstructured command input; unsupported kinds were rejected above.
        const commandLine = text.startsWith('/') ? text : undefined
        if (commandLine !== undefined) {
          const controller = new AbortController()
          rec.commandAbort = controller
          try {
            const result = await commands.execute(rec.agent, commandLine, controller.signal)
            if (result !== undefined && result.text !== undefined && result.text !== '') {
              notify({
                sessionId: rec.agent.session.id,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: {
                    type: 'text',
                    text: result.kind === 'error' ? `Error: ${result.text}` : result.text,
                  },
                },
              })
            } else if (result === undefined) {
              notify({
                sessionId: rec.agent.session.id,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `Error: unknown command: ${commandLine}` },
                },
              })
            }
            return { stopReason: 'end_turn' }
          } catch (error: unknown) {
            if (controller.signal.aborted) return { stopReason: 'cancelled' }
            const rendered = renderThrown(error)
            logger.warn(`acp: command failed: ${rendered}`)
            notify({
              sessionId: rec.agent.session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `Error: command failed: ${rendered}` },
              },
            })
            return { stopReason: 'end_turn' }
          } finally {
            rec.commandAbort = undefined
          }
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
        // session/cancel maps to the queue-aware agent.cancel({ kind: 'user' }): it aborts
        // a RUNNING step, clears the queued + steering FIFOs, and drops a
        // turn that is about to start (the pre-step window) — so a queued-but-
        // not-yet-started prompt never runs, while a prompt accepted afterward
        // remains a separate queued turn. Scoped to THIS session's
        // agent — a cancel in one session never touches another's stream or
        // pending prompt (multi-session isolation).
        // We ALSO settle the in-flight prompt
        // as cancelled directly here: do NOT rely on the resulting turn/end to
        // settle it, because cancel() may drop the turn before any turn/end is
        // emitted, and removing this direct settle would move the RPC's
        // resolution onto a later observer path, changing its timing.
        if (rec.commandAbort !== undefined) {
          rec.commandAbort.abort(new Error('session/cancel'))
        } else {
          rec.agent.cancel({ kind: 'user' })
          settlePrompt(rec, 'cancelled')
        }
        return Promise.resolve()
      },

      async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const rec = requireSession(SessionId(params.sessionId))
        // Every advertised option is a select, so the boolean-shaped variant
        // is a protocol misuse regardless of configId.
        if (typeof params.value !== 'string') {
          throw invalidParams(`config option ${params.configId} is a select; boolean values are not accepted`)
        }
        let directory = modelDirectory(await readModelCatalog(), rec.target.current)
        // Open-turn switches append immediately; idle switches wait for the
        // next prompt-submit. Only values advertised by this composition are
        // accepted, and the session log remains the durable store.
        switch (params.configId) {
          case 'model': {
            const target = directory.targets.get(params.value)
            if (target === undefined) {
              throw invalidParams(`unknown model value ${JSON.stringify(params.value)}`)
            }
            rec.target.current = { ...target }
            const option = directory.option
            /* v8 ignore next -- `targets` is populated only while constructing
               this selector; a found target therefore proves it exists. */
            if (option === undefined) throw internalError('model directory target has no selector')
            directory = {
              ...directory,
              option: { ...option, currentValue: params.value },
            }
            break
          }
          case 'permission': {
            const presets = ctx.get('permission')
            if (presets === undefined) {
              throw invalidParams(`unknown permission value ${JSON.stringify(params.value)}`)
            }
            // A current-value echo is acknowledged without recording a switch.
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
        return { configOptions: configOptionsFor(rec.agent, directory, rec.pendingSwitches) }
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
  conn = new AgentSideConnection(makeAgent, observeOutbound(stream, announceInitialCommands))

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
    pendingCommandSnapshots.clear()
    const recs = [...sessions.values()]
    sessions.clear()
    if (recs.length === 0) return Promise.resolve()
    quiescing = (async () => {
      await Promise.all(recs.map(async (rec) => {
        settlePrompt(rec, 'cancelled')
        rec.commandAbort?.abort(new Error('ACP connection closed'))
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
 * @param config - the plugin config carrying the optional provider/model target.
 * @returns the per-agent options, with each configured target field present.
 */
export function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
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
 * - `llm/retry` and terminal model failure → visible discarded-attempt markers
 * - `user/message` → `user_message_chunk` during load replay only — so a
 *   loaded transcript reconstructs the USER side of each turn without echoing
 *   a live `session/prompt` back to the client
 * - `tool/call`   → `tool_call` (pending)
 * - appended `tool/result` → `tool_call_update` (completed/failed)
 * - replacement `tool/result` → no update (context rewrite, not execution)
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
 * @param terminal - the session's terminal-rendering context; defaults to
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
    case 'llm/retry': {
      const text = '\n\n[Previous model attempt discarded; retrying '
        + `${event.data.retry}/${event.data.maxRetries} in ${event.data.delayMs}ms: `
        + `${event.data.failure.message}]\n\n`
      notify({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
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
      // Replacements (for example model-free pruning) are transcript rewrites,
      // not repeated tool executions. Re-presenting one would consume no
      // pending call and could clobber the original terminal/diff completion.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
      const view = presenter.result(event.data.callId, event.data.content, event.data.isError, event.data.meta)
      notify({ sessionId, update: toolResultUpdate(event.data.callId, view, event.data.isError, terminal) })
      return
    }
    case 'todo/write': {
      notify({ sessionId, update: { sessionUpdate: 'plan', ...todosToPlan(event.data.todos) } })
      return
    }
    case 'session/title': {
      notify({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          title: event.data.title,
          updatedAt: new Date(event.time).toISOString(),
        },
      })
      return
    }
    case 'turn/end': {
      if (event.data.reason.kind !== 'error' || !('failure' in event.data.reason)) return
      const text = `\n\n[Model attempt failed; any partial output above is discarded: ${event.data.reason.failure.message}]\n\n`
      notify({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
      return
    }
    // non-error turn/step boundaries, context/message, steering,
    // assistant/message — no direct ACP client update.
    default:
      return
  }
}

/**
 * Map a whole harness todo list to an ACP replacement plan, using medium
 * priority because harness todos do not carry one.
 * @param todos - complete harness todo list.
 * @returns one ACP plan entry per todo.
 */
export function todosToPlan(todos: TodoItem[]): Plan {
  return { entries: todos.map((todo): PlanEntry => ({ content: todo.content, priority: 'medium', status: todo.status })) }
}

/** Per-session terminal capability and workspace used while translating updates. */
export interface TerminalRendering {
  enabled: boolean
  /** The session workspace cwd (terminal-card header default); `undefined` when the session has none. */
  cwd: string | undefined
}

/** Default: terminal rendering off (the ` ```console ` text fallback path). */
const noTerminalRendering: TerminalRendering = { enabled: false, cwd: undefined }

/**
 * Resolve tool-owned call/result views with a generic fallback. Per-session
 * state correlates results with call arguments; interrupted calls may retain an
 * entry only until that session's presenter is discarded.
 */
export class ToolPresenter {
  private readonly pending = new Map<CallId, { name: string; args: unknown; card: ToolCallView['card'] }>()

  /**
   * @param tools - registry used to resolve executing definitions.
   * @param onError - contained presenter-error sink before generic fallback.
   * @param agent - optional scoped registry view for the executing agent.
   */
  constructor(
    private readonly tools: Pick<ToolRegistry, 'get'>,
    private readonly onError: (message: string) => void = () => {},
    private readonly agent?: Agent,
  ) {}

  /**
   * Pending-state render intent for a `tool/call`; remembers `(name, args, card)`
   * for the matching result.
   * @param callId - the call id the matching `tool/result` will look up.
   * @param name - the tool name, resolved against the registry for `presentCall`.
   * @param argsJson - raw event arguments parsed for presentation.
   * @returns the tool-owned view or generic fallback.
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
    // Tool names never imply presentation kind; richer cards are tool-owned.
    const view: ToolCallView = present ?? { card: 'generic', title: name, kind: 'other', rawInput: args }
    this.pending.set(callId, { name, args, card: view.card })
    return view
  }

  /**
   * Completed-state render intent for a `tool/result`; consumes the remembered
   * `(name, args, card)`.
   * @param callId - matching call id; unknown or late ids use raw content.
   * @param content - result content used by the fallback and fill-in body.
   * @param isError - whether the result is an error, forwarded to `presentResult`.
   * @param meta - the result's machine-readable meta, forwarded when present.
   * @returns a normalized tool-owned view or raw-content fallback.
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

/** Relativize only in-workspace title text; location and diff paths stay raw. */
function displayTitle(title: string, rawPath: string | undefined, sessionCwd: string | undefined): string {
  if (rawPath === undefined || sessionCwd === undefined || !isAbsolute(rawPath) || !isAbsolute(sessionCwd)) return title
  const rel = relativePath(sessionCwd, rawPath)
  // Test the `..` segment, not a character prefix: `..cache/x` is in-workspace.
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
