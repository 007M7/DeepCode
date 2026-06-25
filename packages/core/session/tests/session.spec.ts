import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventType } from '@deepseek-ai/dsh-session'

describe('Session', () => {
  it('derives message history from the event log', () => {
    const session = new Session(SessionId('s1'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } })
    session.append('assistant/message', {
      turn: 1, step: 1,
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{}' },
      ],
    }, { surfaceOp: 'append' })
    session.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const messages = session.deriveMessages()
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    // raw chunks must NOT appear in derived history
    expect(messages[1]!.content).toHaveLength(2)
    expect(messages[2]!.content[0]).toMatchObject({ type: 'tool-result', toolCallId: CallId('c1') })
  })

  it('accepts and round-trips a max-tokens turn/end reason', () => {
    // The max-tokens TurnEndReason variant carries no extra data, so it must
    // append and persist like any other reason (JSON-serializable, no fields).
    const session = new Session(SessionId('s1'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })

    const turnEnd = session.events.findLast(e => e.type === 'turn/end')!
    expect(turnEnd.data.reason).toEqual({ kind: 'max-tokens' })
    // survives a structuredClone (the persistence-serialization boundary)
    expect(structuredClone(turnEnd.data.reason)).toEqual({ kind: 'max-tokens' })
  })

  it('renders context and steering messages as tagged synthetic user content', () => {
    const session = new Session(SessionId('s2'))
    session.append('context/message', {
      content: [{ type: 'text', text: 'file changed: a.ts' }],
      source: { kind: 'plugin', plugin: 'watcher' },
    }, { surfaceOp: 'append' })
    session.append('steering/message', {
      turn: 1,
      content: [{ type: 'text', text: 'focus on tests' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    const [contextMessage, steeringMessage] = session.deriveMessages()
    expect(contextMessage!.role).toBe('user')
    expect(contextMessage!.content[0]).toMatchObject({ type: 'text', text: '<context source="plugin">' })
    expect(contextMessage!.content.at(-1)).toMatchObject({ type: 'text', text: '</context>' })
    expect(steeringMessage!.content[0]).toMatchObject({ type: 'text', text: '<steering source="user">' })
  })

  it('replays identically from a seeded event log', () => {
    const original = new Session(SessionId('s3'))
    original.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    original.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }] }, { surfaceOp: 'append' })

    const replayed = new Session(SessionId('s3-replay'), [...original.events])
    expect(replayed.deriveMessages()).toEqual(original.deriveMessages())
    expect(replayed.seq).toBe(original.seq)
  })

  it('isolates the log from mutation through a derived message (append-only contract)', () => {
    const session = new Session(SessionId('s4'))
    session.append('user/message', { content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1, callId: CallId('c1'),
      content: [{ type: 'text', text: 'tool out' }], isError: false,
    }, { surfaceOp: 'append' })
    const before = structuredClone(session.events)

    // A request middleware / adapter mutates the messages it was handed.
    const messages = session.deriveMessages()
    const userBlock = messages[0]!.content[0]!
    if (userBlock.type === 'text') userBlock.text = 'HACKED'
    const toolBlock = messages[1]!.content[0]!
    if (toolBlock.type === 'tool-result') {
      toolBlock.content.push({ type: 'text', text: 'injected' })
    }
    messages[0]!.content.push({ type: 'text', text: 'extra' })

    // The log is unchanged: deep-equal to the snapshot taken before mutation.
    expect(session.events).toEqual(before)
    // And a fresh derivation still reflects the original content.
    expect(session.deriveMessages()[0]!.content).toEqual([{ type: 'text', text: 'original' }])
  })

  it('rejects non-JSON-serializable event data at the source (incl. sparse arrays)', () => {
    const session = new Session(SessionId('s5'))
    const bad = (extra: unknown) => () => session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra } as never, { surfaceOp: 'append' })
    expect(bad(1n)).toThrow(/non-JSON-serializable/)
    expect(bad(() => 0)).toThrow(/non-JSON-serializable/)
    expect(bad(Symbol('s'))).toThrow(/non-JSON-serializable/)
    expect(bad(new Map())).toThrow(/non-JSON-serializable/)
    expect(bad(undefined)).toThrow(/non-JSON-serializable/)
    expect(bad(Infinity)).toThrow(/non-JSON-serializable/)
    // A sparse array: `every` skips the hole but JSON.stringify writes it null.
    // Build the hole without a sparse literal or `delete` (both linted).
    const sparse: unknown[] = Array(3)
    sparse[0] = 1
    sparse[2] = 3 // index 1 stays a hole
    expect(bad(sparse)).toThrow(/non-JSON-serializable/)
    // A DENSE array carrying a non-serializable element is rejected too.
    expect(bad([1, 2n, 3])).toThrow(/non-JSON-serializable/)
    // A nested non-serializable value (inside a plain object) is rejected.
    expect(bad({ nested: { deep: () => 0 } })).toThrow(/non-JSON-serializable/)
    // A circular reference is rejected (the seen-set guard, not a stack blow-up).
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    expect(bad(cyclic)).toThrow(/non-JSON-serializable/)
    // The rejected appends never entered the log.
    expect(session.events).toHaveLength(0)
  })

  it('rejects a surface-eligible append with no surfaceOp marker (runtime guard for the union-widening loophole)', () => {
    const session = new Session(SessionId('s5b'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // The typed overload makes surfaceOp mandatory only when the type argument is
    // a SPECIFIC SurfaceEventType literal. A caller iterating raw events widens it
    // to the SessionEventType union, where the conditional rest collapses to
    // optional — the exact shape `for (const e of log) append(e.type, e.data)`
    // produces. Reproduce that here and assert the runtime guard rejects it.
    const widenedType = 'user/message' as SessionEventType
    expect(() => session.append(widenedType, { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
      .toThrow(/surface-eligible and requires a surfaceOp marker/)
    // The rejected append never entered the log (only turn/start is present).
    expect(session.events).toHaveLength(1)
  })

  it('accepts dense arrays and nested plain objects', () => {
    const session = new Session(SessionId('s6'))
    expect(() => session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' }, extra: [1, 2, [3, { a: null, b: true }]] } as never, { surfaceOp: 'append' })).not.toThrow()
    expect(session.events).toHaveLength(1)
  })

  it('validates seed events: rejects a non-JSON-serializable seed', () => {
    // A replay/fork seed must satisfy the SAME invariant as Session.append, or
    // it builds a live log no backend can persist.
    const badSeed = [
      { type: 'user/message' as const, seq: 0, time: 1, data: { content: [{ type: 'text' as const, text: 'x' }], source: { kind: 'user' as const }, bad: 1n } },
    ] as unknown as SessionEvent[]
    expect(() => new Session(SessionId('seed-bad'), badSeed)).toThrow(/non-JSON-serializable/)
  })

  it('validates seed events: rejects a non-contiguous seq', () => {
    const gapSeed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'turn/end' as const, seq: 5, time: 2, data: { turn: 1, reason: { kind: 'completed' as const } } }, // gap: expected seq 1
    ] as SessionEvent[]
    expect(() => new Session(SessionId('seed-gap'), gapSeed)).toThrow(/contiguous|seq/)
  })

  it('validates seed events: rejects a surface-eligible event missing its surfaceOp marker', () => {
    // A surface-eligible event (user/message) with no surfaceOp would load fine
    // but vanish from deriveMessages() (the surface is the sole derivation path),
    // so a resume/fork would silently lose history. append() forbids this at
    // compile time; a raw seed must be rejected at runtime to match.
    const markerlessSeed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'user/message' as const, seq: 1, time: 2, data: { content: [{ type: 'text' as const, text: 'hi' }], source: { kind: 'user' as const } } },
      { type: 'turn/end' as const, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' as const } } },
    ] as SessionEvent[]
    expect(() => new Session(SessionId('seed-no-marker'), markerlessSeed)).toThrow(/surface-eligible but carries no surfaceOp/)
  })

  it('accepts a well-formed contiguous serializable seed', () => {
    const goodSeed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'user/message' as const, seq: 1, time: 2, data: { content: [{ type: 'text' as const, text: 'hi' }], source: { kind: 'user' as const } }, surfaceOp: 'append' as const },
      { type: 'turn/end' as const, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' as const } } },
    ] as SessionEvent[]
    const session = new Session(SessionId('seed-ok'), goodSeed)
    expect(session.events).toHaveLength(3)
  })

  it('snapshots the seed: mutating the original after construction does not affect session.events', () => {
    const seed = [
      { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } } },
      { type: 'user/message' as const, seq: 1, time: 2, data: { content: [{ type: 'text' as const, text: 'original' }], source: { kind: 'user' as const } }, surfaceOp: 'append' as const },
      { type: 'turn/end' as const, seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' as const } } },
    ] as SessionEvent[]
    const session = new Session(SessionId('seed-snapshot'), seed)
    // Mutate the ORIGINAL seed objects after construction: a shared reference
    // would let this rewrite the forked log (or reintroduce non-serializable
    // data past validation). The snapshot must shield session.events.
    const um = seed[1]!
    ;(um.data as { content: { type: 'text'; text: string }[] }).content[0]!.text = 'HACKED'
    ;(um.data as Record<string, unknown>)['injected'] = 1n // would have failed validation
    const logged = session.events[1]!
    expect(logged.type === 'user/message' && (logged.data.content[0] as { text: string }).text).toBe('original')
    expect((logged.data as Record<string, unknown>)['injected']).toBeUndefined()
  })

  it('snapshots append data: mutating the passed object after append does not affect session.events', () => {
    const session = new Session(SessionId('append-snapshot'))
    const data = { content: [{ type: 'text' as const, text: 'original' }], source: { kind: 'user' as const } }
    const event = session.append('user/message', data, { surfaceOp: 'append' })
    // Mutate the caller's object after append returns. A shared reference would
    // make session.events diverge from the value that passed validation.
    data.content[0]!.text = 'HACKED'
    ;(data as Record<string, unknown>)['injected'] = 1n
    const logged = session.events[0]!
    expect(logged.type === 'user/message' && (logged.data.content[0] as { text: string }).text).toBe('original')
    expect((logged.data as Record<string, unknown>)['injected']).toBeUndefined()
    // The returned event carries the same snapshot, not the caller's input.
    expect((event.data.content[0] as { text: string }).text).toBe('original')
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

    session.append('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(events).toHaveLength(1)
    expect(events[0]![0]).toBe(session)
    expect(events[0]![1].type).toBe('user/message')

    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(ctx.sessions.list()).toEqual([session])
  })

  it('rejects duplicate ids and supports seeding', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const a = ctx.sessions.create(SessionId('fixed'))
    expect(() => ctx.sessions.create(SessionId('fixed'))).toThrow('already exists')

    a.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const forked = ctx.sessions.create(SessionId('fork'), { seed: [...a.events] })
    expect(forked.deriveMessages()).toEqual(a.deriveMessages())
  })

  it('enter() rejects a stale prepared session whose id is already live (no overwrite)', async () => {
    // prepare()/enter() are public cross-package primitives that a caller may
    // separate with arbitrary work. A stale prepared session must NOT overwrite
    // a live store entry of the same id — its detach disposer would later delete
    // the REAL session, breaking the store-uniqueness invariant.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const stale = ctx.sessions.prepare(SessionId('racy'))
    const live = ctx.sessions.create(SessionId('racy'))
    expect(() => ctx.sessions.enter(stale)).toThrow(/already exists/)
    // The live session is intact and still the store entry.
    expect(ctx.sessions.get(SessionId('racy'))).toBe(live)
  })

  it('prepare() + enter() + announce() register a session and emit session/created', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const created: Session[] = []
    ctx.on('session/created', session => void created.push(session))

    const session = ctx.sessions.prepare(SessionId('lifecycle'))
    // prepare alone does NOT enter the store.
    expect(ctx.sessions.get(SessionId('lifecycle'))).toBeUndefined()
    const detach = ctx.sessions.enter(session)
    expect(ctx.sessions.get(SessionId('lifecycle'))).toBe(session)
    // enter does NOT announce.
    expect(created).toEqual([])
    ctx.sessions.announce(session)
    expect(created).toEqual([session])
    // The detach disposer removes the entry + stops notification.
    detach()
    expect(ctx.sessions.get(SessionId('lifecycle'))).toBeUndefined()
  })

  it('synthesizes a minimal current-version header for a bare-created session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('plain'))
    expect(session.header).toMatchObject({ version: SESSION_FORMAT_VERSION, id: 'plain' })
    expect(typeof session.header.createdAt).toBe('number')
    expect(session.header.cwd).toBeUndefined()
    expect(session.header.parentSession).toBeUndefined()
  })

  it('attaches cwd and parentSession from meta to the header', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('child'), {
      meta: { cwd: '/work/project', parentSession: SessionId('parent') },
    })
    expect(session.header).toMatchObject({
      version: SESSION_FORMAT_VERSION,
      id: 'child',
      cwd: '/work/project',
      parentSession: 'parent',
    })
  })

  it('rejects a non-absolute meta.cwd', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    expect(() => ctx.sessions.create(SessionId('rel'), { meta: { cwd: 'relative/path' } }))
      .toThrow(/cwd must be an absolute path/)
    // the rejected session was not registered
    expect(ctx.sessions.get(SessionId('rel'))).toBeUndefined()
  })

  it('a bare Session() constructed without the store still exposes a current-version header', () => {
    const session = new Session(SessionId('bare'))
    expect(session.header).toMatchObject({ version: SESSION_FORMAT_VERSION, id: 'bare' })
    expect(typeof session.header.createdAt).toBe('number')
  })

  it('detaches sessions when the creating fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    let session!: Session
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('scoped'))
    }, { inject: ['sessions'] }))
    expect(ctx.sessions.get(SessionId('scoped'))).toBe(session)

    let observed = 0
    ctx.on('session/event', () => void observed++)

    await fiber.dispose()
    expect(ctx.sessions.get(SessionId('scoped'))).toBeUndefined()
    session.append('user/message', { content: [{ type: 'text', text: 'late' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(observed).toBe(0)
  })

  it('rolls back the session (and onAppend) when a session/created listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    let threw = false
    ctx.on('session/created', () => {
      if (!threw) { threw = true; throw new Error('boom created listener') }
    })

    // The throwing emit must roll the store entry back, not leak it.
    expect(() => ctx.sessions.create(SessionId('fixed'))).toThrow('boom created listener')
    expect(ctx.sessions.get(SessionId('fixed'))).toBeUndefined() // rolled back, not leaked

    // A subsequent create of the SAME id succeeds (the already-exists check is
    // not wedged) and its onAppend is correctly wired (events observable).
    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => void events.push(event))
    const session = ctx.sessions.create(SessionId('fixed'))
    expect(ctx.sessions.get(SessionId('fixed'))).toBe(session)
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(events).toHaveLength(1)
  })
})
