import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import type { Config } from '@deepseek-ai/dsh-time-context'

const BASE = Date.parse('2026-07-14T00:00:00.000Z')
const ORIGINAL_TIME_ZONE = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'UTC'
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (ORIGINAL_TIME_ZONE === undefined) delete process.env['TZ']
  else process.env['TZ'] = ORIGINAL_TIME_ZONE
})

async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  const fiber = await ctx.plugin(timeContext, config)
  return { ctx, fiber }
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  return { id: AgentId(id), session } as unknown as Agent
}

async function sectionText(ctx: Context, agent?: Agent): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? {} : { agent })
  return assembly.sections.find(section => section.name === 'context:time')?.text
}

function openMessageTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append('user/message', {
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId('tick-1'), name: 'tick', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

async function loopHarness(adapter: ScriptedAdapter, config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(timeContext, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

describe('temporal section rendering', () => {
  it('renders the first turn in UTC with the explicit no-previous-message fallback', async () => {
    const { ctx } = await mount()
    const session = new Session(SessionId('first'))
    openMessageTurn(session, 1)

    expect(await sectionText(ctx, sessionAgent(session))).toBe(
      'Current time: 2026-07-14T00:00:00+00:00[UTC]\n'
      + 'Time since previous message: unavailable (no earlier message in this session).',
    )
  })

  it('renders a non-UTC numeric offset and all compact duration units', async () => {
    const { ctx } = await mount({ timeZone: 'Asia/Shanghai' })
    const session = new Session(SessionId('offset'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'previous' }],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    vi.setSystemTime(BASE + 90_061_000)
    openMessageTurn(session, 2)

    expect(await sectionText(ctx, sessionAgent(session))).toBe(
      'Current time: 2026-07-15T09:01:01+08:00[Asia/Shanghai]\n'
      + 'Time since previous message: 1d 1h 1m 1s.',
    )
  })

  it('clamps a backward wall-clock adjustment to a zero duration', async () => {
    const { ctx } = await mount()
    const session = new Session(SessionId('backward-duration'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'future by adjusted clock' }],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    vi.setSystemTime(BASE - 5_000)
    openMessageTurn(session, 2)

    expect(await sectionText(ctx, sessionAgent(session))).toContain('Time since previous message: 0s.')
  })

  const previousMessageCases = [
    ['user/message', (session: Session): void => {
      session.append('user/message', { content: [{ type: 'text', text: 'u' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    }],
    ['assistant/message', (session: Session): void => {
      session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }] }, { surfaceOp: 'append' })
    }],
    ['tool/result', (session: Session): void => {
      session.append('tool/result', {
        turn: 1,
        step: 1,
        callId: CallId('previous'),
        content: [{ type: 'text', text: 'r' }],
        isError: false,
      }, { surfaceOp: 'append' })
    }],
    ['context/message', (session: Session): void => {
      session.append('context/message', {
        content: [{ type: 'text', text: 'c' }],
        source: { kind: 'plugin', plugin: 'test' },
      }, { surfaceOp: 'append' })
    }],
    ['steering/message', (session: Session): void => {
      session.append('steering/message', {
        turn: 1,
        content: [{ type: 'text', text: 's' }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
    }],
  ] as const

  it.each(previousMessageCases)('uses a prior %s as the duration baseline', async (_name, appendPrevious) => {
    const { ctx } = await mount()
    const session = new Session(SessionId(`previous-${_name}`))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    appendPrevious(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    vi.setSystemTime(BASE + 5_000)
    openMessageTurn(session, 2)

    expect(await sectionText(ctx, sessionAgent(session))).toContain('Time since previous message: 5s.')
  })

  it('contributes empty text without an active agent turn', async () => {
    const { ctx } = await mount()
    expect(await sectionText(ctx)).toBe('')

    const empty = sessionAgent(new Session(SessionId('empty')))
    expect(await sectionText(ctx, empty)).toBe('')

    const closedSession = new Session(SessionId('closed'))
    openMessageTurn(closedSession, 1)
    closedSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(await sectionText(ctx, sessionAgent(closedSession))).toBe('')
  })
})

describe('refresh policy', () => {
  it('reuses within the interval, refreshes at expiry, and refreshes after a backward clock jump', async () => {
    const { ctx } = await mount({ refreshIntervalMs: 60_000 })
    const session = new Session(SessionId('interval'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)

    const first = await sectionText(ctx, agent)
    vi.setSystemTime(BASE + 30_000)
    expect(await sectionText(ctx, agent)).toBe(first)
    vi.setSystemTime(BASE + 60_000)
    const expired = await sectionText(ctx, agent)
    expect(expired).toContain('2026-07-14T00:01:00+00:00[UTC]')
    vi.setSystemTime(BASE + 59_000)
    expect(await sectionText(ctx, agent)).toContain('2026-07-14T00:00:59+00:00[UTC]')
  })

  it('refreshes every assembly when refreshIntervalMs is zero', async () => {
    const { ctx } = await mount({ refreshIntervalMs: 0 })
    const session = new Session(SessionId('every-step'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    const first = await sectionText(ctx, agent)
    vi.setSystemTime(BASE + 1_000)
    expect(await sectionText(ctx, agent)).not.toBe(first)
  })

  it('always refreshes for a new turn and keeps the preceding message baseline', async () => {
    const { ctx } = await mount({ refreshIntervalMs: 60_000 })
    const session = new Session(SessionId('turn-refresh'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    const first = await sectionText(ctx, agent)
    vi.setSystemTime(BASE + 1_000)
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'done' }],
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    vi.setSystemTime(BASE + 2_000)
    openMessageTurn(session, 2)

    const second = await sectionText(ctx, agent)
    expect(second).not.toBe(first)
    expect(second).toContain('Time since previous message: 1s.')
  })

  it('keeps refresh caches independent per agent', async () => {
    const { ctx } = await mount({ refreshIntervalMs: 60_000 })
    const sessionA = new Session(SessionId('agent-a'))
    const sessionB = new Session(SessionId('agent-b'))
    const agentA = sessionAgent(sessionA, 'a')
    const agentB = sessionAgent(sessionB, 'b')
    openMessageTurn(sessionA, 1)
    openMessageTurn(sessionB, 1)
    const aFirst = await sectionText(ctx, agentA)
    vi.setSystemTime(BASE + 30_000)
    const bFirst = await sectionText(ctx, agentB)
    vi.setSystemTime(BASE + 40_000)

    expect(await sectionText(ctx, agentA)).toBe(aFirst)
    expect(bFirst).toContain('2026-07-14T00:00:30+00:00[UTC]')
  })
})

describe('configuration and lifecycle', () => {
  it('defaults to the process system zone and retains the zone resolved at plugin load', async () => {
    process.env['TZ'] = 'Asia/Shanghai'
    const { ctx } = await mount()
    process.env['TZ'] = 'America/New_York'
    const session = new Session(SessionId('system-zone'))
    openMessageTurn(session, 1)

    expect(await sectionText(ctx, sessionAgent(session))).toContain(
      'Current time: 2026-07-14T08:00:00+08:00[Asia/Shanghai]',
    )
  })

  it('fails loud for negative, fractional, unsafe, and invalid-zone config', async () => {
    for (const refreshIntervalMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await expect(ctx.plugin(timeContext, { refreshIntervalMs })).rejects.toThrow(/non-negative safe integer/)
    }

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await expect(ctx.plugin(timeContext, { timeZone: 'Not/A_Real_Zone' })).rejects.toThrow(/invalid IANA timeZone/)
  })

  it('fails loud when the process system zone cannot be resolved', async () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
      throw new RangeError('system zone unavailable')
    })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    await expect(ctx.plugin(timeContext, {})).rejects.toThrow(/failed to resolve the system time zone/)
  })

  it('removes its section when the plugin fiber disposes', async () => {
    const { ctx, fiber } = await mount()
    const session = new Session(SessionId('dispose'))
    const agent = sessionAgent(session)
    openMessageTurn(session, 1)
    expect(await sectionText(ctx, agent)).toContain('Current time:')

    await fiber.dispose()
    expect(await sectionText(ctx, agent)).toBeUndefined()
  })
})

describe('real agent-loop request logging', () => {
  it('refreshes a long turn in the system prompt and records the header delta without context history', async () => {
    const adapter = new ScriptedAdapter([toolCallResponse(), textResponse('done'), textResponse('next turn')])
    const ctx = await loopHarness(adapter, { refreshIntervalMs: 60_000 })
    ctx.tools.register(defineTool({
      name: 'tick',
      description: 'advance fake time',
      parameters: {},
      async execute() {
        vi.setSystemTime(BASE + 61_000)
        return [{ type: 'text' as const, text: 'advanced' }]
      },
    }))
    const agent = ctx.agentLoop.create(AgentId('loop'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'start' }])
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]!.system).toContain('2026-07-14T00:00:00+00:00[UTC]')
    expect(adapter.requests[1]!.system).toContain('2026-07-14T00:01:01+00:00[UTC]')
    expect(agent.session.events.some(event => event.type === 'context/message')).toBe(false)
    expect(agent.session.events.filter(event => event.type === 'request/header-delta')).toHaveLength(1)
    expect(foldRequestHeader(agent.session.events)?.system).toBe(adapter.requests[1]!.system)

    vi.setSystemTime(BASE + 361_000)
    agent.send([{ type: 'text', text: 'again' }])
    await agent.whenIdle()
    expect(adapter.requests[2]!.system).toContain('Time since previous message: 5m 0s.')
    await ctx.fiber.dispose()
  })
})

describe('real Loader export path', () => {
  it('keeps the namespace metadata and boots through unwrapExports', async () => {
    expect('default' in timeContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeContext) as Record<string, unknown>
    expect(unwrapped).toBe(timeContext)
    expect(unwrapped.name).toBe('time-context')
    expect(unwrapped.inject).toEqual(['systemPrompt'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const plugin = loader.unwrapExports(timeContext) as Parameters<Context['plugin']>[0]
    await ctx.plugin(plugin)
    const session = new Session(SessionId('loader'))
    openMessageTurn(session, 1)
    expect(await sectionText(ctx, sessionAgent(session))).toContain('Current time:')
  })
})
