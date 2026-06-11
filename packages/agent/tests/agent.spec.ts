import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Agent, AgentId } from '@deepseek-ai/dsh-agent'

function stubAgent(rawId: string): Agent {
  const id = AgentId(rawId)
  return {
    id,
    options: {},
    session: new Session(SessionId(`${id}-session`)),
    status: 'idle',
    send() {},
    steer() {},
    inject() {},
    abort() {},
  }
}

describe('AgentRegistry', () => {
  it('registers agents and emits created/disposed events', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)

    const created: string[] = []
    const disposed: string[] = []
    ctx.on('agent/created', agent => void created.push(agent.id))
    ctx.on('agent/disposed', agent => void disposed.push(agent.id))

    const agent = stubAgent('a1')
    const dispose = ctx.agents.register(agent)
    expect(created).toEqual(['a1'])
    expect(ctx.agents.get('a1')).toBe(agent)
    expect(ctx.agents.list()).toEqual([agent])

    dispose()
    expect(disposed).toEqual(['a1'])
    expect(ctx.agents.get('a1')).toBeUndefined()
  })

  it('rejects duplicate ids and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    ctx.agents.register(stubAgent('main'))
    expect(() => ctx.agents.register(stubAgent('main'))).toThrow('already registered')

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.register(stubAgent('scoped'))
    }, { inject: ['agents'] }))
    expect(ctx.agents.list().map(a => a.id)).toEqual(['main', 'scoped'])

    await fiber.dispose()
    expect(ctx.agents.list().map(a => a.id)).toEqual(['main'])
  })
})
