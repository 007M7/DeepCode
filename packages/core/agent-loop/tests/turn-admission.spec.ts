import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import AgentRegistry, { type Agent, type InboxItem } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function itemText(item: InboxItem): string {
  return item.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

interface InboxRecording {
  readonly events: string[]
  readonly enqueued: InboxItem['id'][]
  readonly dequeued: InboxItem['id'][]
  readonly discarded: InboxItem['id'][]
}

/** Record the complete inbox lifecycle of one agent for order and identity assertions. */
function recordInbox(ctx: Context): InboxRecording {
  const events: string[] = []
  const enqueued: InboxItem['id'][] = []
  const dequeued: InboxItem['id'][] = []
  const discarded: InboxItem['id'][] = []
  ctx.on('agent/inbox/enqueue', (_agent, item) => {
    events.push(`enqueue:${item.placement}:${itemText(item)}`)
    enqueued.push(item.id)
  })
  ctx.on('agent/inbox/dequeue', (_agent, item) => {
    events.push(`dequeue:${itemText(item)}`)
    dequeued.push(item.id)
  })
  ctx.on('agent/inbox/discard', (_agent, items) => {
    events.push(`discard:${items.map(itemText).join(',')}`)
    discarded.push(...items.map(item => item.id))
  })
  return { events, enqueued, dequeued, discarded }
}

/** Text of every ordinary prompt the log admitted, in durable order. */
function promptTexts(agent: Agent): string[] {
  return agent.session.events.flatMap(event => event.type === 'user/message'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

describe('idle turn admission reservation', () => {
  it('holds later waking prompts in the FIFO until release', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const inbox = recordInbox(ctx)

    const release = agent.reserveTurnAdmission()
    expect(release).toBeDefined()

    prompt(agent, 'first prompt')
    prompt(agent, 'second prompt')
    expect(agent.acceptsNextStep).toBe(false)
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })

    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.events).toHaveLength(0)
    expect(inbox.events).toEqual([
      'enqueue:queued:first prompt',
      'enqueue:queued:second prompt',
    ])

    release?.()
    await agent.whenIdle()

    expect(promptTexts(agent)).toEqual(['first prompt', 'second prompt'])
    expect(agent.session.events.flatMap(event =>
      event.type === 'turn/start' ? [event.data.turn] : [])).toEqual([1, 2])
    expect(inbox.events).toEqual([
      'enqueue:queued:first prompt',
      'enqueue:queued:second prompt',
      'dequeue:first prompt',
      'dequeue:second prompt',
    ])
    expect(inbox.dequeued).toEqual(inbox.enqueued)
    expect(inbox.discarded).toEqual([])
  })

  it('refuses acquisition when an accepted waking prompt still owns the next turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    prompt(agent, 'accepted first')
    expect(agent.status).toBe('idle')
    expect(agent.reserveTurnAdmission()).toBeUndefined()

    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('refuses acquisition while a turn is running', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const reserved: unknown[] = []
    ctx.on('agent/step', () => {
      reserved.push(agent.reserveTurnAdmission())
    })

    prompt(agent, 'running')
    await agent.whenIdle()

    expect(agent.status).toBe('idle')
    expect(reserved).toEqual([undefined])
  })

  it('refuses a second reservation and releases idempotently', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const release = agent.reserveTurnAdmission()
    expect(agent.reserveTurnAdmission()).toBeUndefined()
    prompt(agent, 'queued behind the reservation')

    release?.()
    release?.()
    await agent.whenIdle()

    expect(promptTexts(agent)).toEqual(['queued behind the reservation'])
    expect(adapter.requests).toHaveLength(1)
    const second = agent.reserveTurnAdmission()
    expect(second).toBeDefined()
    second?.()
  })

  it('ignores a stale release once a later reservation owns the boundary', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const stale = agent.reserveTurnAdmission()
    stale?.()
    const live = agent.reserveTurnAdmission()
    prompt(agent, 'held by the live reservation')
    stale?.()
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })

    expect(adapter.requests).toHaveLength(0)
    live?.()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('acquires beside quiet queued work and leaves it queued', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.send(createUserMessage({
      content: [{ type: 'text', text: 'quiet' }],
      source: { kind: 'user' },
    }), {
      target: 'next-turn',
      wakeup: false,
    })
    const release = agent.reserveTurnAdmission()
    expect(release).toBeDefined()

    release?.()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
  })

  it('makes whenIdle() wait for release without spinning on a settled promise', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const machine = agent as Agent & { done: Promise<void> }
    let backing = machine.done
    let reads = 0
    Object.defineProperty(agent, 'done', {
      configurable: true,
      get(): Promise<void> {
        reads += 1
        return backing
      },
      set(value: Promise<void>) {
        backing = value
      },
    })

    const release = agent.reserveTurnAdmission()
    prompt(agent, 'waiting for the reservation')
    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
    }

    expect(settled).toBe(false)
    expect(reads).toBeLessThanOrEqual(2)

    release?.()
    await idle
    expect(settled).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('resolves whenIdle() after release with nothing queued', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const release = agent.reserveTurnAdmission()
    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    expect(settled).toBe(false)

    release?.()
    await idle
    expect(agent.status).toBe('idle')
  })

  it('lets cancellation discard held prompts and keeps the boundary quiet', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const inbox = recordInbox(ctx)

    const release = agent.reserveTurnAdmission()
    prompt(agent, 'discarded while held')
    agent.cancel({ kind: 'user' })

    expect(inbox.events).toEqual([
      'enqueue:queued:discarded while held',
      'discard:discarded while held',
    ])
    expect(inbox.discarded).toEqual(inbox.enqueued)
    expect(inbox.dequeued).toEqual([])

    release?.()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.events).toHaveLength(0)
  })

  it('disposes the agent without waiting for the reservation to be released', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('a1'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const { agent } = handle

    const release = agent.reserveTurnAdmission()
    prompt(agent, 'discarded by disposal')
    await handle.dispose()

    expect(ctx.agents.list()).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    release?.()
  })
})
