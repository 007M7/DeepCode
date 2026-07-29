import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MAIN_SESSION_ID_KEY, SESSIONS_ROOT_KEY, type MainSessionIdentity } from '@deepseek-ai/dsh-tui'
import * as tuiAgent from '../src/index.ts'

interface PluginCall {
  readonly name: string
  readonly config: unknown
}

/**
 * Record the composed plugin tree. `identity` stands in for the launcher-owned
 * {@link MAIN_SESSION_ID_KEY} slot; omitting it means no launcher chose a session.
 */
function recordingContext(
  identity?: MainSessionIdentity,
  sessionsRoot?: string,
): { readonly ctx: Context; readonly calls: PluginCall[] } {
  const calls: PluginCall[] = []
  const ctx = {
    plugin(plugin: { name?: string }, config?: unknown) {
      calls.push({ name: plugin.name ?? '', config })
    },
    get: (key: string) => key === MAIN_SESSION_ID_KEY ? identity
      : key === SESSIONS_ROOT_KEY ? sessionsRoot : undefined,
  } as unknown as Context
  return { ctx, calls }
}

describe('dsh-tui-demo app', () => {
  it('composes the TUI cluster around one fresh exact session identity', () => {
    const { ctx, calls } = recordingContext()
    tuiAgent.composeTuiApp(ctx, {
      provider: 'mock',
      model: 'mock-model',
      maxParallelToolCalls: 3,
      persona: 'test persona',
      toolOrder: ['zulu', TOOL_ORDER_REST],
      tools: { mode: 'code' },
      dshHome: '/tmp/dsh-home',
      persistenceRoot: '/tmp/tui-sessions',
      persistenceCompression: 'none',
      sessionReferences: {
        maxReferences: 2,
        candidateLimit: 7,
        maxReferenceBytes: 1234,
      },
      welcome: 'TUI ready',
      ui: { theme: { color: false }, maxToolOutputLines: 3 },
      skills: { tool: { catalogDescriptionMaxLength: 8 } },
      toolBash: { enableRunInBackground: false },
      toolTasks: { waitTimeoutMs: 7, maxWaitTimeoutMs: 11 },
      workspaceContext: false,
    })

    expect(calls.map(call => call.name)).toEqual([
      'CommandService',
      'command-goal',
      'SessionPersistenceJsonl',
      'session-checkpoint-policy',
      'SessionQuerySqlite',
      'SessionReferenceService',
      'UserInteractionService',
      'TuiPromptService',
      'ui-tui',
      'agent-spine-demo',
      'tool-ask-user',
    ])
    expect(calls[0]?.config).toBeUndefined()
    expect(calls[2]?.config).toEqual({ root: '/tmp/tui-sessions', compression: 'none' })
    expect(calls[4]?.config).toEqual({ path: join('/tmp/tui-sessions', 'session-query.db') })
    expect(calls[5]?.config).toEqual({
      maxReferences: 2,
      candidateLimit: 7,
      maxReferenceBytes: 1234,
    })
    const tuiConfig = calls[8]?.config as { sessionId: string }
    expect(tuiConfig).toMatchObject({
      welcome: 'TUI ready',
      theme: { color: false },
      maxToolOutputLines: 3,
    })
    expect(tuiConfig.sessionId).toMatch(/^main-session-[0-9a-f-]{36}$/)
    const spineConfig = calls[9]?.config as {
      readonly agents: Array<Record<string, unknown>>
      readonly goals: Record<string, never>
      readonly maxParallelToolCalls: number
      readonly persona: string
      readonly toolOrder: string[]
      readonly tools: { mode: string }
    }
    expect(spineConfig).toMatchObject({
      maxParallelToolCalls: 3,
      persona: 'test persona',
      toolOrder: ['zulu', TOOL_ORDER_REST],
      tools: { mode: 'code' },
      goals: {},
    })
    expect(spineConfig.agents[0]).toMatchObject({
      id: 'main',
      provider: 'mock',
      model: 'mock-model',
      cwd: process.cwd(),
      sessionId: tuiConfig.sessionId,
    })
  })

  it('uses the launcher sessions-root slot through schema-normalized config', () => {
    // The Loader normalizes config through the schemastery Config BEFORE apply
    // runs. A schema .default() on persistenceRoot would materialize here and
    // permanently shadow the launcher slot — the regression this test pins.
    const normalized = tuiAgent.Config({
      provider: 'mock',
      model: 'mock-model',
      workspaceContext: false,
    } as never)
    expect(normalized.persistenceRoot).toBeUndefined()

    const { ctx, calls } = recordingContext(undefined, '/launcher/sessions')
    tuiAgent.composeTuiApp(ctx, normalized)
    expect(calls[2]?.config).toMatchObject({ root: '/launcher/sessions' })
    expect(calls[4]?.config).toEqual({ path: join('/launcher/sessions', 'session-query.db') })
  })

  it('lets an explicit persistenceRoot win over the launcher slot', () => {
    const { ctx, calls } = recordingContext(undefined, '/launcher/sessions')
    tuiAgent.composeTuiApp(ctx, {
      provider: 'mock',
      model: 'mock-model',
      persistenceRoot: '/explicit/root',
      workspaceContext: false,
    })
    expect(calls[2]?.config).toEqual({ root: '/explicit/root' })
  })

  it('loads persisted history for a launcher-selected resume identity', () => {
    // The bundle default stays project-local: shared-store policy is the
    // launcher's, which patches `persistenceRoot` itself (the dsh CLI does).
    const { ctx, calls } = recordingContext({ id: SessionId('persisted-session'), resume: true })
    tuiAgent.composeTuiApp(ctx, {
      provider: 'mock',
      model: 'mock-model',
      workspaceContext: false,
    })

    expect(calls[2]?.config).toEqual({ root: './.sessions' })
    expect(calls[4]?.config).toEqual({ path: join('./.sessions', 'session-query.db') })
    expect(calls[5]?.config).toEqual({})
    // No configured welcome forwards none: the TUI banner sweeps in without a subtitle.
    expect(calls[8]?.config).toEqual({ sessionId: 'persisted-session' })
    expect((calls[9]?.config as { agents: Array<Record<string, unknown>> }).agents[0]).toMatchObject({
      id: 'main',
      resumeSessionId: 'persisted-session',
    })
  })

  it('creates a launcher-minted identity fresh rather than loading history', () => {
    const { ctx, calls } = recordingContext({ id: SessionId('minted-session'), resume: false })
    tuiAgent.composeTuiApp(ctx, {
      provider: 'mock',
      model: 'mock-model',
      workspaceContext: false,
    })

    expect(calls[8]?.config).toEqual({ sessionId: 'minted-session' })
    expect((calls[9]?.config as { agents: Array<Record<string, unknown>> }).agents[0])
      .toMatchObject({ id: 'main', sessionId: 'minted-session' })
  })

  it('mints a fresh session with no launcher slot and routes apply through the same composition', () => {
    const { ctx, calls } = recordingContext()
    tuiAgent.apply(ctx, {
      provider: 'mock',
      model: 'mock-model',
      goals: false,
      workspaceContext: false,
    })

    const tuiConfig = calls[7]?.config as { sessionId: string }
    expect(tuiConfig.sessionId).toMatch(/^main-session-[0-9a-f-]{36}$/)
    expect((calls[8]?.config as { agents: Array<Record<string, unknown>> }).agents[0])
      .toMatchObject({ sessionId: tuiConfig.sessionId })
    expect(calls.map(call => call.name)).not.toContain('command-goal')
    expect(calls[8]?.config).toMatchObject({ goals: false })
  })

  it('has the namespace-plugin export shape so the Loader keeps its schema', () => {
    expect(tuiAgent.name).toBe('tui-demo')
    expect(tuiAgent.Config).toBeDefined()
    expect('default' in tuiAgent).toBe(false)
    expect(typeof tuiAgent.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tuiAgent) as Record<string, unknown>
    expect(unwrapped).toBe(tuiAgent)
    expect(unwrapped.name).toBe('tui-demo')
    expect(unwrapped.Config).toBeDefined()
  })
})
