import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandService from '@deepseek-ai/dsh-commands'
import SessionStore, { foldSurface, Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandFeedback from '@deepseek-ai/dsh-command-feedback'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    ctx: new Context(),
    get status() { return status },
    get acceptsNextStep() { return status === 'running' },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Mount the real command registry and this producer. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  const plugin = await ctx.plugin(commandFeedback)
  const { agent, session } = stubAgent(ctx, `command-feedback-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

/** Execute `/feedback` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<{ kind: string; text?: string }> {
  const settled = await test.ctx.commands.execute(
    test.agent,
    `/feedback${suffix}`,
    new AbortController().signal,
  )
  if (settled === undefined) throw new Error('feedback command was not registered')
  return settled.result
}

/** The registry's durable record of each accepted command, in log order. */
function commandRecords(session: Session): { name: string; args: string; kind: string }[] {
  const runs = session.events.filter(event => event.type === 'command/run')
  return runs.map((event) => {
    const done = session.events.find(item =>
      item.type === 'command/done' && item.data.commandId === event.data.commandId)
    if (done?.type !== 'command/done') throw new Error('every command/run must be paired')
    return { name: event.data.name, args: event.data.args, kind: done.data.kind }
  })
}

describe('@deepseek-ai/dsh-command-feedback registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandFeedback.name).toBe('command-feedback')
    expect(commandFeedback.inject).toEqual(['commands'])
    expect('default' in commandFeedback).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandFeedback)).toBe(commandFeedback)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'feedback',
      description: 'record feedback about this session',
      input: { hint: '<text>' },
    })
    expect(test.ctx.commands.find(test.agent, 'feedback')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'feedback')).toBeUndefined()
  })
})

describe('/feedback human command', () => {
  it('acknowledges feedback and leaves the registry record as its durable trace', async () => {
    const test = await harness()
    await expect(run(test, ' the diff view is unreadable')).resolves.toEqual({
      kind: 'success',
      text: 'Feedback recorded.',
    })
    expect(commandRecords(test.session)).toEqual([
      { name: 'feedback', args: ' the diff view is unreadable', kind: 'success' },
    ])
  })

  it('adds no event of its own beyond the registry pairing', async () => {
    const test = await harness()
    await run(test, ' nothing else happens')
    // The whole point of the command: record and do nothing. Only the
    // registry's own pairing appears, and no turn of model work starts.
    expect(test.session.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
  })

  it('records verbatim text, including input that looks like another command', async () => {
    const test = await harness()
    await run(test, ' /plan felt SLOW\n\ttwice today ')
    expect(commandRecords(test.session)).toEqual([
      { name: 'feedback', args: ' /plan felt SLOW\n\ttwice today ', kind: 'success' },
    ])
  })

  it('records each entry separately without replacing earlier ones', async () => {
    const test = await harness()
    await run(test, ' first')
    await run(test, ' second')
    expect(commandRecords(test.session).map(record => record.args)).toEqual([' first', ' second'])
  })

  it('records concurrent submissions in dispatch order', async () => {
    const test = await harness()
    const signal = new AbortController().signal
    // The shipped TUI dispatches commands fire-and-forget.
    const settled = await Promise.all([
      test.ctx.commands.execute(test.agent, '/feedback first', signal),
      test.ctx.commands.execute(test.agent, '/feedback second', signal),
    ])
    expect(settled.map(item => item?.result)).toEqual([
      { kind: 'success', text: 'Feedback recorded.' },
      { kind: 'success', text: 'Feedback recorded.' },
    ])
    expect(commandRecords(test.session).map(record => record.args)).toEqual([' first', ' second'])
  })

  it('keeps every recorded event off the model surface and out of derived history', async () => {
    const test = await harness()
    await run(test, ' invisible to the model')
    for (const event of test.session.events) {
      expect('surfaceOp' in event).toBe(false)
      expect(test.session.deriveEventMessage(event)).toBeNull()
    }
    expect(foldSurface(test.session.events).nodes).toEqual([])
    expect(test.session.surface.nodes).toEqual([])
    expect(test.session.deriveMessages()).toEqual([])
  })

  it('rejects empty and whitespace-only input as a failed command record', async () => {
    const test = await harness()
    const expected = {
      kind: 'error',
      text: 'Feedback text is required. Usage: /feedback <text>',
    }
    await expect(run(test)).resolves.toEqual(expected)
    await expect(run(test, '   \n\t ')).resolves.toEqual(expected)
    // Rejected input still leaves the registry's own pairing, settled as an
    // error, so no entry is mistaken for accepted feedback.
    expect(commandRecords(test.session).map(record => record.kind)).toEqual(['error', 'error'])
  })

  it('records nothing when dispatch rejects an already-cancelled request', async () => {
    const test = await harness()
    const controller = new AbortController()
    controller.abort(new Error('user cancelled the command'))
    await expect(test.ctx.commands.execute(test.agent, '/feedback too late', controller.signal))
      .rejects.toThrow('user cancelled the command')
    expect(test.session.events).toEqual([])
  })
})
