import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import SessionStore, { Session, SessionEvent } from '@deepseek-ai/dsh-session'

describe('Session', () => {
  it('derives message history from the event log', () => {
    const session = new Session('s1')
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } })
    session.append('assistant/message', {
      turn: 1, step: 1,
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{}' },
      ],
    })
    session.append('tool/result', { turn: 1, step: 1, callId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const messages = session.deriveMessages()
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    // raw chunks must NOT appear in derived history
    expect(messages[1].content).toHaveLength(2)
    expect(messages[2].content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'c1' })
  })

  it('renders context and steering messages as tagged synthetic user content', () => {
    const session = new Session('s2')
    session.append('context/message', {
      content: [{ type: 'text', text: 'file changed: a.ts' }],
      source: { kind: 'plugin', plugin: 'watcher' },
    })
    session.append('steering/message', {
      turn: 1,
      content: [{ type: 'text', text: 'focus on tests' }],
      source: { kind: 'user' },
    })

    const [contextMessage, steeringMessage] = session.deriveMessages()
    expect(contextMessage.role).toBe('user')
    expect(contextMessage.content[0]).toMatchObject({ type: 'text', text: '<context source="plugin">' })
    expect(contextMessage.content.at(-1)).toMatchObject({ type: 'text', text: '</context>' })
    expect(steeringMessage.content[0]).toMatchObject({ type: 'text', text: '<steering source="user">' })
  })

  it('replays identically from a seeded event log', () => {
    const original = new Session('s3')
    original.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } })
    original.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }] })

    const replayed = new Session('s3-replay', [...original.events])
    expect(replayed.deriveMessages()).toEqual(original.deriveMessages())
    expect(replayed.seq).toBe(original.seq)
  })
})

describe('SessionStore', () => {
  it('creates sessions, emits session/created and session/event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    const created: Session[] = []
    const events: [Session, SessionEvent][] = []
    ctx.on('session/created', session => void created.push(session))
    ctx.on('session/event', (session, event) => void events.push([session, event]))

    const session = ctx.sessions.create()
    expect(created).toEqual([session])

    session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })
    expect(events).toHaveLength(1)
    expect(events[0][0]).toBe(session)
    expect(events[0][1].type).toBe('user/message')

    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(ctx.sessions.list()).toEqual([session])
  })

  it('rejects duplicate ids and supports seeding', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const a = ctx.sessions.create('fixed')
    expect(() => ctx.sessions.create('fixed')).toThrow('already exists')

    a.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } })
    const forked = ctx.sessions.create('fork', [...a.events])
    expect(forked.deriveMessages()).toEqual(a.deriveMessages())
  })

  it('detaches sessions when the creating fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    let session!: Session
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('scoped')
    }, { inject: ['sessions'] }))
    expect(ctx.sessions.get('scoped')).toBe(session)

    let observed = 0
    ctx.on('session/event', () => void observed++)

    await fiber.dispose()
    expect(ctx.sessions.get('scoped')).toBeUndefined()
    session.append('user/message', { content: [{ type: 'text', text: 'late' }], source: { kind: 'user' } })
    expect(observed).toBe(0)
  })
})
