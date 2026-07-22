import { Context } from 'cordis'
import type { Terminal } from '@earendil-works/pi-tui'
import AgentRegistry, {
  type Agent,
  type AgentCancelCause,
  type AgentOptions,
  type AgentStatus,
} from '@deepseek-ai/dsh-agent'
import type { ContentBlock, LlmModelContext, LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import CommandService from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import { createTuiChat, type Config, type TuiRuntime } from '../src/index.ts'

interface FakeAgent extends Agent {
  status: AgentStatus
  sent: ContentBlock[][]
  steered: ContentBlock[][]
  cancelled: AgentCancelCause[]
}

export interface TuiHarnessOptions {
  status?: AgentStatus
  config?: Config
  /** Leave the session event log empty instead of seeding one turn and step. */
  omitInitialLifecycle?: boolean
  /** Omit the harness's default `welcome`, exercising the banner sweep-reveal path. */
  omitWelcome?: boolean
  tools?: Record<string, ToolDefinition>
  configureContext?: (ctx: Context) => Promise<void>
  beforeMount?: (session: Session) => void
  cwd?: string | null
  formatCwd?: TuiRuntime['formatCwd']
  /** Fake-agent creation options (`provider`/`model` seed the model selector's initial target). */
  agentOptions?: AgentOptions
  contextWindow?: number
  contextTokens?: number
  now?: () => number
  catalog?: {
    providers: LlmProviderInfo[]
    models: LlmModelInfo[]
    listModels?: (provider: string) => Promise<LlmModelInfo[]>
    resolveModelContext?: (provider: string, model: string) => Promise<LlmModelContext | undefined>
  }
  /** Provide a fake `sessionPersistence` service so resume surfaces can list sessions. */
  sessionPersistence?: { list(): Promise<SessionHeader[]> }
}

export interface TuiHarness<TerminalType extends Terminal, Exit extends (code: number) => void> {
  ctx: Context
  session: Session
  agent: FakeAgent
  terminal: TerminalType
  exit: Exit
  controller: ReturnType<typeof createTuiChat>
}

/**
 * Compose the production TUI around an in-memory session and controllable agent.
 * @param terminal - Terminal boundary driven by the test.
 * @param exit - Process-exit observer.
 * @param options - Initial session, agent, tool, and TUI configuration.
 * @returns The mounted TUI and every boundary the test may drive or inspect.
 */
export async function createTuiTestHarness<TerminalType extends Terminal, Exit extends (code: number) => void>(
  terminal: TerminalType,
  exit: Exit,
  options: TuiHarnessOptions = {},
): Promise<TuiHarness<TerminalType, Exit>> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandService)
  await ctx.plugin(UserInteractionService)
  const catalog = options.catalog ?? {
    providers: [{ id: 'deepseek', name: 'DeepSeek' }],
    models: [
      { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  }
  ctx.provide('tokenMeter', {
    measure() {
      return { totalTokens: options.contextTokens ?? 0 }
    },
  } as never)
  if (options.configureContext === undefined) {
    const tools = options.tools ?? {}
    ctx.provide('tools', {
      get(name: string) {
        return tools[name]
      },
    } as never)
  } else {
    await options.configureContext(ctx)
  }
  // A configureContext may mount the real LlmService; only fill the
  // advisory-catalog stub when none was provided.
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders() {
        return catalog.providers.map(provider => ({ ...provider }))
      },
      listModels(provider: string) {
        return catalog.listModels?.(provider)
          ?? Promise.resolve(catalog.models.filter(model => model.provider === provider).map(model => ({ ...model })))
      },
      resolveModelContext(provider: string, model: string) {
        return catalog.resolveModelContext?.(provider, model)
          ?? Promise.resolve({ contextWindow: options.contextWindow ?? 128_000 })
      },
    } as never)
  }
  if (ctx.get('systemPrompt') === undefined) await ctx.plugin(SystemPrompt)
  if (options.sessionPersistence !== undefined) {
    ctx.provide('sessionPersistence', options.sessionPersistence as never)
  }
  const sessionId = SessionId('main-session')
  const session = ctx.sessions.create(
    sessionId,
    options.cwd === null ? undefined : { meta: { cwd: options.cwd ?? '/workspace' } },
  )
  if (options.omitInitialLifecycle !== true) {
    session.append('turn/start', {
      turn: 1,
      trigger: { kind: 'message', source: { kind: 'user' } },
    })
    session.append('step/start', { turn: 1, step: 1 })
  }
  options.beforeMount?.(session)
  const sent: ContentBlock[][] = []
  const steered: ContentBlock[][] = []
  const cancelled: AgentCancelCause[] = []
  const agent: FakeAgent = {
    id: sessionId,
    options: options.agentOptions ?? { provider: 'deepseek', model: 'deepseek-v4-flash' },
    session,
    status: options.status ?? 'idle',
    ctx,
    sent,
    steered,
    cancelled,
    send(content) {
      sent.push(content)
    },
    steer(content) {
      steered.push(content)
    },
    inject() {},
    cancel(cause = { kind: 'user' }) {
      cancelled.push(cause)
    },
    whenIdle() {
      return Promise.resolve()
    },
  }
  ctx.agents.register(agent)
  const controller = createTuiChat(ctx, Object.assign({
    ...options.omitWelcome === true ? {} : { welcome: 'Coding agent ready.' },
    sessionId,
    color: false,
  }, options.config), {
    terminal,
    exit,
    // Default to the real clock (runtime.now falls back to Date.now) so the
    // elapsed-status suites can drive time via timers or Date.now spies; a
    // test pins the clock only by passing `now` explicitly.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.formatCwd === undefined ? {} : { formatCwd: options.formatCwd }),
  })
  return { ctx, session, agent, terminal, exit, controller }
}

/** Dispose the mounted TUI before its owning Cordis context. */
export async function disposeTuiTestHarness(
  setup: Pick<TuiHarness<Terminal, (code: number) => void>, 'controller' | 'ctx'>,
): Promise<void> {
  await setup.controller.dispose()
  await setup.ctx.fiber.dispose()
}

/** Append a production-shaped user message to the active session surface. */
export function appendUser(session: Session, text: string): void {
  session.append('user/message', {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
}

/** Append a production-shaped assistant message to the active session surface. */
export function appendAssistant(
  session: Session,
  content: ContentBlock[],
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  position: { turn: number; step: number } = { turn: 1, step: 1 },
): void {
  session.append('assistant/message', {
    ...position,
    provenance: { provider: 'mock', model: 'deepseek-v4-flash' },
    content,
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
}
