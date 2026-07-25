/**
 * Host-side ApiProxy implementation. Signature discipline: unary takes the
 * narrow RpcRequest<P> and echoes request.rpcId on the RpcResponse<T>.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { JsonValue, Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { Workspace, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import {
  workspaceDomainState, workspaceRecord, WorkspaceId as brandWorkspaceId, WorkspaceNameConflictError,
} from '@deepseek-ai/dsh-workspace'
// Type-only: brings the `ctx.tools` Context merge into this program (viewFor reads presenters).
import type {} from '@deepseek-ai/dsh-tools'
import type {
  ApiProxy, HistoryEntry, HostFrame, MuxFrame, QuestionResponsePayload, SessionSummary, ToolEventView,
  WorkspaceId, WorkspaceView,
} from './api/index.ts'
import { questionResponsePayloadSchema } from './api/questions.schema.ts'
import type { ClientResponse, RpcError, RpcReceipt, RpcRequest, RpcResponse } from './api/rpc.ts'
import { RpcId } from './api/rpc.ts'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-interaction'
import { UserInteractionError } from '@deepseek-ai/dsh-user-interaction'

/** Page size when history is called without maxMessages. */
const DEFAULT_MAX_MESSAGES = 50

/** Surface message event types (the pagination counting unit). */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'steering/message'])

/**
 * Message-boundary pagination: count maxMessages surface messages backwards from
 * the window tail; the cut is the starting seq of the oldest message group
 * (chunks group via sourceEventSeqs — never cut mid-message). The tail page
 * naturally includes the in-progress partial.
 */
function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  const window = beforeSeq === undefined ? [...events] : events.filter(event => event.seq < beforeSeq)
  let count = 0
  let cut = 0
  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type)) continue
    count++
    const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    const groupStart = sources !== undefined && sources.length > 0 ? Math.min(event.seq, ...sources) : event.seq
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  const page = window.filter(event => event.seq >= cut)
  return { events: page, hasMore: cut > 0 }
}

/** Wrap an ok result echoing the request's rpcId. */
function ok<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

/** Wrap an error result echoing the request's rpcId. */
function err<T>(request: RpcRequest<unknown>, error: RpcError): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: false, error } }
}

/** Simple async queue: core callbacks push, the AsyncIterable pulls; abort/return cleans up. */
class FrameQueue<F> {
  private buffer: F[] = []
  private waiter: (() => void) | undefined
  private done = false

  push(item: F): void {
    if (this.done) return
    this.buffer.push(item)
    this.waiter?.()
  }

  end(): void {
    this.done = true
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.buffer.length > 0) yield this.buffer.shift() as F
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
  }
}

/**
 * Server-side frame mint: pure pushes get a fresh rpcId per frame (stable ids
 * for answerable frames belong to the approval/question registry, absent in
 * this minimal version).
 */
function frame<F>(payload: F): RpcRequest<F> {
  return { rpcId: RpcId(randomUUID()), payload }
}

type SessionTitleFrame = Extract<MuxFrame, { type: 'session/title' }>

/** Project the latest durable title without exposing title-generation policy. */
function titleFrame(session: Session): SessionTitleFrame | undefined {
  const title = foldSessionTitle(session.events)
  if (title === undefined) return undefined
  return {
    type: 'session/title',
    sessionId: session.id,
    title: title.title,
    eventSeq: title.eventSeq,
    updatedAt: title.updatedAt,
  }
}

/** Queue the subscription baseline followed by its optional title snapshot. */
function subscribeSession(queue: FrameQueue<RpcRequest<MuxFrame>>, session: Session): void {
  queue.push(frame({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 }))
  const title = titleFrame(session)
  if (title !== undefined) queue.push(frame(title))
}

/** SessionSummary projection for attached (in-memory) sessions. */
function summarize(session: Session, running: boolean): SessionSummary {
  return {
    sessionId: session.id,
    updatedAt: session.events.at(-1)?.time ?? session.header.createdAt,
    running,
    ...session.header.parentSession === undefined ? {} : { parentSessionId: session.header.parentSession },
    ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
  }
}

/**
 * SessionSummary projection for cold (persisted, unattached) sessions.
 * updatedAt is the log file's mtime; backends without a per-session file
 * (locate() undefined) fall back to the header's createdAt.
 */
async function summarizeCold(persistence: SessionPersistence, meta: SessionHeader): Promise<SessionSummary> {
  let updatedAt = meta.createdAt
  const location = persistence.locate(meta)
  if (location !== undefined) {
    try {
      updatedAt = (await stat(location.path)).mtimeMs
    } catch {
      // The log vanished between list() and stat() (concurrent cleanup); createdAt stands in.
    }
  }
  return {
    sessionId: meta.id,
    updatedAt,
    running: false,
    ...meta.parentSession === undefined ? {} : { parentSessionId: meta.parentSession },
    /* v8 ignore next -- the empty arm needs a cwd-less meta, but list()
    filters those out (legacy logs are not served); the conditional mirrors
    summarize() shape. */
    ...meta.cwd === undefined ? {} : { cwd: meta.cwd },
  }
}

/** Resolved Host routing and project-directory defaults consumed by the API implementation. */
export interface ApiProxyDefaults {
  provider: string
  model: string
  /** Default project directory for new sessions whose create request carries no cwd. */
  cwd: string
  /** Parent directory for name-created workspaces. */
  workspaceRoot: string
}

/** The tool/call payload fields the presenter path reads. */
interface ToolCallData { callId: string; name: string; arguments: string }
/** The tool/result payload fields the presenter path reads. */
interface ToolResultData { callId: string; content: ContentBlock[]; isError: boolean; meta?: JsonValue }

/** One host-owned question wait, addressed by the stable server-request id. */
interface PendingQuestion {
  rpcId: RpcId
  sessionId: SessionId
  questions: AskUserQuestionItem[]
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: UserInteractionError) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** Validate one answer batch against the exact question request it resolves. */
function matchesQuestions(payload: QuestionResponsePayload, pending: PendingQuestion): boolean {
  if (payload.sessionId !== pending.sessionId) return false
  const answers = payload.answer.answers
  if (answers.length !== pending.questions.length) return false
  return answers.every((answer, index) => {
    const question = pending.questions[index] as AskUserQuestionItem
    if (answer.id !== question.id) return false
    if (new Set(answer.selected).size !== answer.selected.length) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (custom !== undefined && answer.selected.length > 0) return false
    if (question.multiSelect !== true && answer.selected.length > 1) return false
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return answer.selected.every(label => labels.has(label))
  })
}

/**
 * Compute the render intent for a tool/call or tool/result event through the
 * presenters registered at this moment; every other event type gets none. A
 * result's presenter needs its call's parsed args — `argsFor` supplies them
 * (live: the per-session call table; history: an in-page backscan), returning
 * undefined when the pairing is unavailable (e.g. the call fell off the page),
 * which soft-falls to no view. Presenter or JSON.parse throws also soft-fall:
 * the client's documented default (generic JSON card) covers every miss.
 */
function viewFor(ctx: Context, event: SessionEvent, argsFor: (callId: string) => unknown): ToolEventView | undefined {
  try {
    if (event.type === 'tool/call') {
      const { name, arguments: raw } = event.data as ToolCallData
      const view = ctx.tools.get(name)?.presentCall?.(JSON.parse(raw))
      return view === undefined ? undefined : { for: 'call', view }
    }
    if (event.type === 'tool/result') {
      const { callId, content, isError, meta } = event.data as ToolResultData
      const call = argsFor(callId) as { name: string; args: unknown } | undefined
      if (call === undefined) return undefined
      const view = ctx.tools.get(call.name)?.presentResult?.(call.args, { content, isError, ...meta === undefined ? {} : { meta } })
      return view === undefined ? undefined : { for: 'result', view }
    }
  } catch (error: unknown) {
    // A throwing presenter (or unparseable arguments) must not break delivery;
    // the event still ships, just without a view.
    console.error(`api-proxy: presenter failed for ${event.type}, falling back to generic: ${String(error)}`)
  }
  return undefined
}

/**
 * Resolve a tool/result's call pairing by scanning a window of events backwards
 * for the matching tool/call. Used by the history path (the page is the
 * window — a cross-page pairing soft-falls to no view) and by live-path table
 * misses after a reconnect-eviction.
 */
function backscanArgs(events: readonly SessionEvent[], callId: string): { name: string; args: unknown } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent
    if (event.type !== 'tool/call') continue
    const data = event.data as ToolCallData
    if (data.callId !== callId) continue
    try {
      return { name: data.name, args: JSON.parse(data.arguments) }
    } catch {
      // Unparseable stored arguments: same soft-fall as a live parse failure.
      return undefined
    }
  }
  return undefined
}

/**
 * Thrown by the cold-resume path when the id names no servable session
 * (absent from the store, or a pre-project legacy log without a cwd).
 */
class SessionNotFound extends Error {}

/** Requested identity already belongs to a session with another project cwd. */
class SessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      `session "${sessionId}" already exists with cwd ${JSON.stringify(existingCwd)}; `
      + `requested ${JSON.stringify(requestedCwd)}`,
    )
  }
}

/** Host failed before the registry could adopt a name-created directory. */
class WorkspaceDirectoryCreationError extends Error {}

/** Wire projection of one workspace entity (the workspace.* value row). */
function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/** Wire projection of the durable record carried by `domain/changed`. */
function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: workspaceId as WorkspaceId,
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Implement ApiProxy over a composed host context.
 * @param ctx - a context with the Host spine and Workspace registry mounted.
 * @param defaults - host routing and project-directory defaults.
 * @returns the ApiProxy implementation.
 */
export function createApiProxy(ctx: Context, defaults: ApiProxyDefaults): ApiProxy {
  const agentOptions = { provider: defaults.provider, model: defaults.model }
  /** Implicit resume of cold sessions, deduplicating concurrent calls (follows the jsonrpc sessionCreations precedent). */
  const resumes = new Map<SessionId, Promise<Agent>>()
  /** Client-chosen identity creation/resume, deduplicated across concurrent retries. */
  const sessionCreations = new Map<SessionId, Promise<Agent>>()
  /** Serializes path ownership checks with record creation across spellings. */
  let workspaceCreationChain = Promise.resolve()
  const pendingQuestions = new Map<RpcId, PendingQuestion>()
  const muxQueues = new Set<FrameQueue<RpcRequest<MuxFrame>>>()

  /** Send one transient frame to every connected mux consumer. */
  function broadcast(payload: MuxFrame): void {
    const envelope = frame(payload)
    for (const queue of muxQueues) queue.push(envelope)
  }

  /** Remove a wait before settling it: synchronous deletion makes the first claimant win. */
  function claimQuestion(pending: PendingQuestion, outcome: 'answered' | 'cancelled'): void {
    pendingQuestions.delete(pending.rpcId)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    broadcast({
      type: 'question/resolved', sessionId: pending.sessionId,
      questionRpcId: pending.rpcId, outcome,
    })
  }

  const disposeProvider = ctx.userInteraction.registerProvider({
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
      const sessionId = request.agent?.id
      if (sessionId === undefined) {
        return Promise.reject(new UserInteractionError(
          'web user interaction requires an agent-owned session', 'ASK_MISSING_AGENT'))
      }
      return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        const rpcId = RpcId(randomUUID())
        const pending: PendingQuestion = {
          rpcId, sessionId, questions: request.questions, resolve, reject,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }
        const onAbort = (): void => {
          claimQuestion(pending, 'cancelled')
          reject(new UserInteractionError(
            'ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
        }
        pending.onAbort = onAbort
        pendingQuestions.set(rpcId, pending)
        request.signal?.addEventListener('abort', onAbort, { once: true })
        const envelope: RpcRequest<MuxFrame> = {
          rpcId,
          payload: { type: 'question/requested', sessionId, questions: request.questions },
        }
        for (const queue of muxQueues) queue.push(envelope)
      })
    },
  })
  ctx.effect(() => () => {
    disposeProvider()
    for (const pending of [...pendingQuestions.values()]) {
      claimQuestion(pending, 'cancelled')
      pending.reject(new UserInteractionError(
        'web user-interaction provider was disposed', 'ASK_ABORTED'))
    }
  }, 'api-proxy: user-interaction provider')

  /**
   * Gate the cold path on the store: an id absent from it, or naming a legacy
   * log without a cwd (pre-release stance: not served, no compatibility), is
   * not-found before any resume is attempted. With the gate passed, a later
   * resume failure is genuinely internal. No persistence configured skips the
   * gate — resume itself then fails loud with its own diagnostic.
   */
  async function assertServable(sessionId: SessionId): Promise<void> {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return
    const meta = (await persistence.list()).find(m => m.id === sessionId)
    if (meta === undefined || meta.cwd === undefined) throw new SessionNotFound(`session "${sessionId}" not found`)
  }

  async function agentFor(sessionId: SessionId): Promise<{ agent: Agent } | { error: RpcError }> {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return { agent: live }
    let resume = resumes.get(sessionId)
    if (resume === undefined) {
      resume = (async () => {
        try {
          await assertServable(sessionId)
          const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
          return handle.agent
        } finally {
          resumes.delete(sessionId)
        }
      })()
      resumes.set(sessionId, resume)
    }
    try {
      return { agent: await resume }
    } catch (error: unknown) {
      if (error instanceof SessionNotFound) {
        return { error: { code: 'session-not-found', message: error.message, details: { sessionId } } }
      }
      // The internal details slot is contractually {}; the reason rides the message.
      return { error: { code: 'internal', message: `resume failed for session "${sessionId}": ${String(error)}`, details: {} } }
    }
  }

  /** Resolve one requested identity to a live agent, creating or resuming it once. */
  async function ensureSession(sessionId: SessionId, cwd: string, checkPersistedIdentity: boolean): Promise<Agent> {
    let creation = sessionCreations.get(sessionId)
    if (creation === undefined) {
      creation = (async () => {
        const live = ctx.agents.get(sessionId)
        if (live !== undefined) return live

        const persistence = checkPersistedIdentity ? ctx.get('sessionPersistence') : undefined
        const stored = persistence === undefined
          ? undefined
          : (await persistence.list()).find(header => header.id === sessionId)
        if (stored !== undefined) {
          if (stored.cwd !== cwd) {
            throw new SessionCwdConflict(sessionId, cwd, stored.cwd)
          }
          return (await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })).agent
        }

        try {
          await mkdir(cwd, { recursive: true })
        } catch (error: unknown) {
          throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
        }
        return (await ctx.agents.create({ sessionId, agentOptions, meta: { cwd } })).agent
      })().catch((error: unknown) => {
        // Another Host entry path may have published the same identity while
        // this operation crossed an asynchronous persistence/filesystem step.
        const live = ctx.agents.get(sessionId)
        if (live !== undefined) return live
        throw error
      }).finally(() => {
        sessionCreations.delete(sessionId)
      })
      sessionCreations.set(sessionId, creation)
    }
    const agent = await creation
    if (agent.session.header.cwd !== cwd) {
      throw new SessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /** Resolve or create one path while holding the Host's workspace-create chain. */
  function ensureWorkspace(
    path: string,
    title: string | undefined,
    rejectExistingName = false,
    createDirectory = false,
  ): Promise<{ workspace: Workspace; created: boolean }> {
    const operation = workspaceCreationChain.then(async () => {
      if (rejectExistingName && title !== undefined
        && ctx.workspace.list().some(workspace => workspace.title === title)) {
        throw new WorkspaceNameConflictError(title)
      }
      if (createDirectory) {
        try {
          await mkdir(path, { recursive: true })
        } catch (error: unknown) {
          throw new WorkspaceDirectoryCreationError(
            `failed to create workspace directory "${path}": ${String(error)}`,
          )
        }
      }
      const existing = await ctx.workspace.resolveByPath(path)
      if (existing !== undefined) return { workspace: existing, created: false }
      return { workspace: await ctx.workspace.create(path, title), created: true }
    })
    workspaceCreationChain = operation.then(() => undefined, () => undefined)
    return operation
  }

  return {
    sessions: {
      // Attached sessions summarize from memory; persisted-but-unattached (cold)
      // sessions merge in from the persistence store so history survives restarts.
      // Legacy logs without a cwd (pre-project stance) are not served — every
      // session now records its project at create time.
      async list(request) {
        const items = ctx.sessions.list().map((session) => {
          const agent = ctx.agents.get(session.id)
          return summarize(session, agent?.status === 'running')
        })
        const attached = new Set(items.map(item => item.sessionId))
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          const cold = (await persistence.list()).filter(meta => !attached.has(meta.id) && meta.cwd !== undefined)
          items.push(...await Promise.all(cold.map(meta => summarizeCold(persistence, meta))))
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt)
        return ok(request, { items })
      },

      async create(request) {
        const sessionId = request.payload.sessionId ?? `session-${randomUUID()}` as SessionId
        let workspace: Workspace | undefined
        if (request.payload.workspaceId !== undefined) {
          workspace = ctx.workspace.get(brandWorkspaceId(request.payload.workspaceId))
          if (workspace === undefined) {
            return err(request, {
              code: 'workspace-not-found',
              message: `workspace "${request.payload.workspaceId}" not found`,
              details: { workspaceId: request.payload.workspaceId },
            })
          }
        }
        const cwd = workspace?.path ?? request.payload.cwd ?? defaults.cwd
        try {
          await ensureSession(sessionId, cwd, request.payload.sessionId !== undefined)
        } catch (error: unknown) {
          if (error instanceof SessionCwdConflict) {
            return err(request, {
              code: 'session-conflict',
              message: error.message,
              details: {
                sessionId: error.sessionId,
                requestedCwd: error.requestedCwd,
                ...error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd },
              },
            })
          }
          return err(request, {
            code: 'internal',
            message: `failed to create session "${sessionId}": ${String(error)}`,
            details: {},
          })
        }
        if (workspace !== undefined) {
          try {
            await workspace.attachSession(sessionId)
          } catch (error: unknown) {
            return err(request, {
              code: 'workspace-attach-failed',
              message: `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
              details: { sessionId, workspaceId: workspace.id },
            })
          }
        }
        return ok(request, { sessionId })
      },

      async history(request) {
        const { sessionId, beforeSeq, maxMessages } = request.payload
        const found = await agentFor(sessionId)
        if ('error' in found) return err(request, found.error)
        const page = paginate(found.agent.session.events, beforeSeq, maxMessages ?? DEFAULT_MAX_MESSAGES)
        // Views are computed against the registry at pagination time; result
        // pairing scans within the page only (message-boundary pagination keeps
        // a call and its result on one page — a cross-page miss soft-falls).
        const entries: HistoryEntry[] = page.events.map((event) => {
          const view = viewFor(ctx, event, callId => backscanArgs(page.events, callId))
          return { event, ...view === undefined ? {} : { view } }
        })
        return ok(request, { events: entries, hasMore: page.hasMore })
      },

      async prompt(request) {
        const { sessionId, mode, content } = request.payload
        const found = await agentFor(sessionId)
        if ('error' in found) return err(request, found.error)
        const agent = found.agent
        // The rpcId rides MessageSource into user/message (merge declaration in api/sessions.ts; provisional correlation).
        const source: MessageSource = { kind: 'user', rpcId: request.rpcId }
        try {
          if (mode === 'steer') agent.steer(content, { source })
          else agent.followup(content, { source })
        } catch (error: unknown) {
          // A synchronous throw from send/steer means disposed or invalid input; surface as agent-busy with the reason attached.
          return err(request, { code: 'agent-busy', message: 'prompt rejected', details: { reason: String(error) } })
        }
        return ok(request, { accepted: true as const })
      },

      cancel(request) {
        const { sessionId } = request.payload
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) {
          return Promise.resolve(err(request, {
            code: 'session-not-found',
            message: `session "${sessionId}" not found (not attached)`,
            details: { sessionId },
          }))
        }
        agent.cancel()
        return Promise.resolve(ok(request, { accepted: true as const }))
      },
    },

    workspace: {
      list(request) {
        return Promise.resolve(ok(request, { items: ctx.workspace.list().map(workspaceView) }))
      },

      // Exactly one of path/name arrives (schema refine). Existing-folder
      // adoption reuses its canonical path; create-by-name rejects a name
      // already present in the registry.
      async create(request) {
        const { payload } = request
        let path: string
        if (payload.name !== undefined) {
          const name = payload.name.trim()
          if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
            return err(request, {
              code: 'workspace-invalid-path',
              message: `workspace name must be one non-empty path segment, got "${payload.name}"`,
              details: { path: payload.name },
            })
          }
          path = join(defaults.workspaceRoot, name)
        } else {
          path = payload.path as string
        }
        try {
          const name = payload.name?.trim()
          const { workspace, created } = await ensureWorkspace(
            path,
            name,
            name !== undefined,
            name !== undefined,
          )
          return ok(request, { workspace: workspaceView(workspace), created })
        } catch (error: unknown) {
          if (error instanceof WorkspaceNameConflictError) {
            return err(request, {
              code: 'workspace-name-conflict',
              message: error.message,
              details: { name: error.workspaceName },
            })
          }
          if (error instanceof WorkspaceDirectoryCreationError) {
            return err(request, { code: 'internal', message: error.message, details: {} })
          }
          // The registry rejects a path that does not resolve to an existing
          // directory (realpath ENOENT / not-a-directory) — the business
          // error of the typed-path flow, surfaced as a validation failure.
          return err(request, {
            code: 'workspace-invalid-path',
            message: `cannot create a workspace at "${path}": ${error instanceof Error ? error.message : String(error)}`,
            details: { path },
          })
        }
      },

    },

    host: {
      describe(request) {
        // TODO(step2): version should read apps/cli's package.json; placeholder for now.
        return Promise.resolve(ok(request, {
          version: '0.0.1',
          // Same source as session.create's fallback: the UI's default project
          // must match where an unspecified-cwd session actually lands.
          cwd: defaults.cwd,
          provider: defaults.provider,
          model: defaults.model,
          attachedSessions: ctx.agents.list().length,
        }))
      },
    },

    events: {
      mux(_request, signal) {
        const queue = new FrameQueue<RpcRequest<MuxFrame>>()
        muxQueues.add(queue)
        for (const session of ctx.sessions.list()) {
          subscribeSession(queue, session)
        }
        for (const pending of pendingQuestions.values()) {
          queue.push({
            rpcId: pending.rpcId,
            payload: {
              type: 'question/requested', sessionId: pending.sessionId,
              questions: pending.questions,
            },
          })
        }
        // Per-session open-call table for result-view pairing. Bounded by the
        // per-turn call count: entries clear on turn/end; a table miss (stream
        // opened mid-turn) backscans the session's in-memory events instead.
        const openCalls = new Map<SessionId, Map<string, { name: string; args: unknown }>>()
        const disposers = [
          ctx.on('session/event', (session: Session, event: SessionEvent) => {
            if (event.type === 'tool/call') {
              const data = event.data as ToolCallData
              try {
                let table = openCalls.get(session.id)
                if (table === undefined) openCalls.set(session.id, table = new Map<string, { name: string; args: unknown }>())
                table.set(data.callId, { name: data.name, args: JSON.parse(data.arguments) })
              } catch {
                // Unparseable model arguments: leave the table unset; the result view soft-falls.
              }
            } else if (event.type === 'turn/end') {
              openCalls.delete(session.id)
            }
            const view = viewFor(ctx, event, callId =>
              openCalls.get(session.id)?.get(callId) ?? backscanArgs(session.events, callId))
            queue.push(frame({ type: 'session/event', sessionId: session.id, event, ...view === undefined ? {} : { view } }))
            if (event.type === 'session/title') {
              // The accepted raw event is already in session.events, so the fold must find it.
              queue.push(frame(titleFrame(session) as SessionTitleFrame))
            }
          }),
          ctx.on('session/created', (session: Session) => {
            subscribeSession(queue, session)
          }),
          ctx.on('session/disposed', (session: Session) => {
            openCalls.delete(session.id)
          }),
        ]
        return queue.iterate(signal, () => {
          muxQueues.delete(queue)
          for (const dispose of disposers) dispose()
        })
      },

      host(_request, signal) {
        const queue = new FrameQueue<RpcRequest<HostFrame>>()
        const committedWorkspaceIds = new Set(
          ctx.workspace.list().map(workspace => String(workspace.id)),
        )
        const disposers = [
          ctx.on('session/created', (session: Session) => {
            queue.push(frame({
              type: 'host/session-added',
              sessionId: session.id,
              ...session.header.parentSession === undefined ? {} : { parentSessionId: session.header.parentSession },
              // cwd rides the frame so the client list needs no refresh to group the new session.
              ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
            }))
          }),
          ctx.on('session/disposed', (session: Session) => {
            queue.push(frame({ type: 'host/session-removed', sessionId: session.id }))
          }),
          ctx.on('agent/status', (agent: Agent, status: AgentStatus) => {
            if (status === 'disposed') return
            queue.push(frame({ type: 'host/session-status', sessionId: agent.id, running: status === 'running' }))
          }),
          ctx.on('agent/error', (agent: Agent, _turn: number, _step: number, error: Error) => {
            queue.push(frame({ type: 'host/agent-error', sessionId: agent.id, message: String(error) }))
          }),
          ctx.on('domain/changed', (change) => {
            if (change.domain !== 'workspace' || change.operation !== 'put') return
            if (change.table === '') {
              const state = workspaceDomainState.parse(change.value)
              for (const workspaceId of state.workspaceIds) {
                if (committedWorkspaceIds.has(workspaceId)) continue
                const workspace = ctx.workspace.get(workspaceId)
                if (workspace === undefined) {
                  throw new Error(`committed workspace registry references missing workspace "${workspaceId}"`)
                }
                committedWorkspaceIds.add(workspaceId)
                queue.push(frame({ type: 'host/workspace-changed', workspace: workspaceView(workspace) }))
              }
              return
            }
            if (change.table !== 'workspaces' || !committedWorkspaceIds.has(change.key)) return
            // Existing-entity table writes are complete attach/touch commits.
            // A new entity's first put waits for the global registry write above.
            queue.push(frame({
              type: 'host/workspace-changed',
              workspace: changedWorkspaceView(change.key, change.value),
            }))
          }),
        ]
        return queue.iterate(signal, () => { for (const dispose of disposers) dispose() })
      },
    },

    respond(message: ClientResponse): Promise<RpcReceipt> {
      const pending = pendingQuestions.get(message.rpcId)
      if (pending === undefined) return Promise.resolve({ accepted: false, reason: 'not-pending' })
      if (!message.result.ok) {
        if (message.result.error.code !== 'cancelled') {
          return Promise.resolve({ accepted: false, reason: 'bad-response' })
        }
        claimQuestion(pending, 'cancelled')
        pending.reject(new UserInteractionError(
          'the user cancelled ask_user_question', 'ASK_CANCELLED'))
        return Promise.resolve({ accepted: true })
      }
      const parsed = questionResponsePayloadSchema.safeParse(message.result.value)
      if (!parsed.success) {
        return Promise.resolve({ accepted: false, reason: 'bad-response' })
      }
      const payload: QuestionResponsePayload = {
        sessionId: parsed.data.sessionId,
        answer: {
          answers: parsed.data.answer.answers.map(answer => ({
            id: answer.id,
            selected: answer.selected,
            ...(answer.custom === undefined ? {} : { custom: answer.custom }),
          })),
        },
      }
      if (!matchesQuestions(payload, pending)) {
        return Promise.resolve({ accepted: false, reason: 'bad-response' })
      }
      claimQuestion(pending, 'answered')
      pending.resolve(payload.answer)
      return Promise.resolve({ accepted: true })
    },
  }
}
