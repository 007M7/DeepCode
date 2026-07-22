import { describe, expect, it } from 'vitest'
import type { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import * as tuiAgent from '../src/index.ts'

interface PluginCall {
  readonly name: string
  readonly config: unknown
}

function recordingContext(): { readonly ctx: Context; readonly calls: PluginCall[] } {
  const calls: PluginCall[] = []
  const ctx = {
    plugin(plugin: { name?: string }, config?: unknown) {
      calls.push({ name: plugin.name ?? '', config })
    },
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
      welcome: 'TUI ready',
      resumeCommand: 'dsh --resume {session}',
      ui: { color: false, maxToolOutputLines: 3 },
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
      'UserInteractionService',
      'ui-tui',
      'agent-spine-demo',
      'tool-ask-user',
    ])
    expect(calls[0]?.config).toBeUndefined()
    expect(calls[2]?.config).toEqual({ root: '/tmp/tui-sessions', compression: 'none' })
    const tuiConfig = calls[5]?.config as { sessionId: string }
    expect(tuiConfig).toMatchObject({
      welcome: 'TUI ready',
      resumeCommand: 'dsh --resume {session}',
      color: false,
      maxToolOutputLines: 3,
    })
    expect(tuiConfig.sessionId).toMatch(/^main-session-[0-9a-f-]{36}$/)
    const spineConfig = calls[6]?.config as {
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

  it('resumes the configured session and applies runtime defaults', () => {
    const { ctx, calls } = recordingContext()
    tuiAgent.composeTuiApp(ctx, {
      provider: 'mock',
      model: 'mock-model',
      resumeSessionId: 'persisted-session',
      workspaceContext: false,
    })

    expect(calls[2]?.config).toEqual({ root: './.sessions' })
    // No configured welcome forwards none: the TUI banner sweeps in without a subtitle.
    expect(calls[5]?.config).toEqual({ sessionId: 'persisted-session' })
    expect((calls[6]?.config as { agents: Array<Record<string, unknown>> }).agents[0]).toMatchObject({
      id: 'main',
      resumeSessionId: 'persisted-session',
    })
  })

  it('normalizes an empty resume id and routes apply through the same composition', () => {
    const { ctx, calls } = recordingContext()
    tuiAgent.apply(ctx, {
      provider: 'mock',
      model: 'mock-model',
      resumeSessionId: '',
      goals: false,
      workspaceContext: false,
    })

    const tuiConfig = calls[4]?.config as { sessionId: string }
    expect(tuiConfig.sessionId).toMatch(/^main-session-[0-9a-f-]{36}$/)
    expect((calls[5]?.config as { agents: Array<Record<string, unknown>> }).agents[0])
      .toMatchObject({ sessionId: tuiConfig.sessionId })
    expect(calls.map(call => call.name)).not.toContain('command-goal')
    expect(calls[5]?.config).toMatchObject({ goals: false })
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
