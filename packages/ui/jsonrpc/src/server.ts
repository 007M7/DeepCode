/**
 * JSON-RPC methods and notifications for SDK clients. Requests are
 * `initialize`, repeated `session/prompt`, then `shutdown`; notifications carry
 * durable session events, settled turns, and subagent lineage/outcomes. The
 * external `cordis.yml` owns plugins, persistence, and the adapter set.
 *
 * @module @deepseek-ai/dsh-jsonrpc/server
 */

import type { Context } from 'cordis'
import { resolve } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { AgentId } from '@deepseek-ai/dsh-agent'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { JsonRpcTransportPeer } from './transport.ts'

/** One-time SDK initialization parameters. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Model name every SDK-created agent runs on (see {@link HarnessSdkServer.initialize} for adapter fallback). */
  model: string
}

/** SDK handshake result. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/**
 * Parameters of a `session/prompt` request: one user turn on one SDK session,
 * with at most one in flight per session.
 */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Accepted prompt result; the outcome is reported by `session.finished`. */
export interface SessionPromptResult {
  /** Always `true`; the turn outcome is the paired `session.finished` notification. */
  accepted: true
}

interface SessionRecord {
  handle: AgentHandle
  lastTurnEnd: TurnEndReason | undefined
  activePrompt: boolean
}

interface SubagentRecord {
  childSessionId: string
  parentSessionId: string | undefined
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkServer {
  private cwd = process.cwd()
  private model = 'deepseek'
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly subagentSessions = new Map<string, SubagentRecord>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
  ) {
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        const rec = this.sessions.get(String(session.id))
        if (rec) rec.lastTurnEnd = event.data.reason
      }
      this.transport.notify('session.event', { sessionId: String(session.id), event })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      this.transport.notify('subagent.started', {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      })
    }))
    // Cache lineage before child disposal removes the agent from the registry.
    this.disposers.push(ctx.on('agent/created', (agent) => {
      this.subagentSessions.set(String(agent.id), {
        childSessionId: String(agent.session.id),
        parentSessionId: agent.session.header.parentSession === undefined
          ? undefined
          : String(agent.session.header.parentSession),
      })
    }))
    this.disposers.push(ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
      const rec = this.subagentSessions.get(String(info.id))
      const agent = this.ctx.agents.get(info.id)
      const childSessionId = rec?.childSessionId ?? (agent === undefined ? undefined : String(agent.session.id))
      const parentSessionId = rec?.parentSessionId ?? (
        agent?.session.header.parentSession === undefined ? undefined : String(agent.session.header.parentSession)
      )
      if (childSessionId === undefined) return
      this.transport.notify('subagent.finished', {
        provider: info.provider,
        agentId: String(info.id),
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        childSessionId,
        status: info.stopReason === 'completed' ? 'ok' : 'error',
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      })
    }))
  }

  /**
   * Record cwd and model, mounting the DeepSeek adapter only when the config
   * registered no adapter for that model.
   * @param params - the SDK handshake parameters.
   * @returns the server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    this.cwd = resolve(params.cwd)
    this.model = params.model
    if (!this.llmFiber && !this.hasAdapterFor(this.model)) {
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, { models: [this.model] })
    }
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Get or create the session agent, send the prompt, await quiescence, then
   * notify `session.finished`. A session accepts one prompt at a time; other
   * sessions remain independent.
   * @param params - the target session id and prompt content.
   * @returns `{ accepted: true }` after the turn settled.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = await this.getOrCreateSession(params.sessionId)
    if (rec.activePrompt) throw new Error(`session already has an active prompt: ${params.sessionId}`)
    rec.activePrompt = true
    try {
      rec.lastTurnEnd = undefined
      rec.handle.agent.send(params.contentBlocks)
      await rec.handle.agent.whenIdle()
      const status = this.finishedStatus(rec.lastTurnEnd)
      this.transport.notify('session.finished', {
        sessionId: params.sessionId,
        status,
        reason: rec.lastTurnEnd,
      })
      return { accepted: true }
    } finally {
      rec.activePrompt = false
    }
  }

  /**
   * Dispose SDK-created agents to quiescence, unmount the server-mounted adapter,
   * and detach subscriptions. The surrounding context remains running.
   * @returns an empty object (the JSON-RPC result).
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    this.subagentSessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch an incoming request; unknown methods throw for transport conversion
   * to a JSON-RPC error response.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    const handle = await this.ctx.agents.create({
      agentId: AgentId(sessionId),
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: { model: this.model },
    })
    const rec: SessionRecord = { handle, lastTurnEnd: undefined, activePrompt: false }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private finishedStatus(reason: TurnEndReason | undefined): 'ok' | 'error' {
    if (!reason) return 'error'
    return reason.kind === 'completed' ? 'ok' : 'error'
  }

  private hasAdapterFor(model: string): boolean {
    return this.ctx.get('llm')?.models().includes(model) ?? false
  }
}
