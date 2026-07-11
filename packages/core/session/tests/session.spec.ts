import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CreateSessionOptions, SessionEventType, SessionHeader, TodoItem } from '@deepseek-ai/dsh-session'

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
    original.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    original.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    original.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }] }, { surfaceOp: 'append' })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

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

    // A misbehaving consumer tries to mutate the messages it was handed.
    // Derived messages are frozen shared projections (cloned once off the
    // log, then deep-frozen): every mutation attempt THROWS in strict mode —
    // isolation by unrepresentability, not by per-call cloning.
    const messages = session.deriveMessages()
    const userBlock = messages[0]!.content[0]!
    expect(() => { if (userBlock.type === 'text') userBlock.text = 'HACKED' }).toThrow(TypeError)
    const toolBlock = messages[1]!.content[0]!
    expect(() => {
      if (toolBlock.type === 'tool-result') toolBlock.content.push({ type: 'text', text: 'injected' })
    }).toThrow(TypeError)
    expect(() => { messages[0]!.content.push({ type: 'text', text: 'extra' }) }).toThrow(TypeError)
    // The returned ARRAY is the caller's own snapshot, though — reordering it
    // is the caller's business and never reaches the cache or the log.
    messages.reverse()

    // The log is unchanged: deep-equal to the snapshot taken before mutation.
    expect(session.events).toEqual(before)
    // And a fresh derivation still reflects the original content and order.
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

  it('rejects a non-string event type without retaining or freezing caller data', () => {
    const session = new Session(SessionId('invalid-event-type'))
    const type = { tag: 'caller-owned' }
    const appendRaw = session.append.bind(session) as unknown as (type: unknown, data: unknown) => SessionEvent

    expect(() => appendRaw(type, {})).toThrow(/event type must be a string/)
    expect(Object.isFrozen(type)).toBe(false)
    expect(session.events).toEqual([])
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
    expect(() => new Session(SessionId('seed-bad'), badSeed)).toThrow(/losslessly JSON-serializable/)
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
    expect(() => new Session(SessionId('seed-no-marker'), markerlessSeed)).toThrow(/requires a surfaceOp marker/)
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

  it('reads each seed array entry once so validation and storage use the same event', () => {
    const accepted = {
      type: 'turn/start' as const,
      seq: 0,
      time: 1,
      data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } },
    }
    const drifted = { ...accepted, seq: 99, data: { invalid: 1n } }
    let reads = 0
    const seed = new Array<SessionEvent>(1)
    Object.defineProperty(seed, 0, {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? accepted : drifted
      },
    })

    const session = new Session(SessionId('seed-entry-snapshot'), seed)

    expect(reads).toBe(1)
    expect(session.events).toEqual([accepted])
  })

  it('reads a nested seed-data getter once and stores its first JSON value', () => {
    let reads = 0
    const data = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 'accepted' : 1n
      },
    })
    const seed = [{ type: 'test/unstable', seq: 0, time: 1, data }] as unknown as SessionEvent[]

    const session = new Session(SessionId('seed-nested-drift'), seed)

    expect(reads).toBe(1)
    expect(session.events[0]!.data).toEqual({ value: 'accepted' })
  })

  it('rejects non-JSON surface metadata in a seed event', () => {
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      surfaceOp: { op: 'replace', start: 1n, end: 2 },
    }] as unknown as SessionEvent[]

    expect(() => new Session(SessionId('seed-bad-metadata'), seed))
      .toThrow(/losslessly JSON-serializable/)
  })

  it('rejects exotic seed metadata before cloning can erase its prototype', () => {
    class ReplaceOp {
      readonly op = 'replace' as const
      readonly start = 0
      readonly end = 0
    }
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      surfaceOp: new ReplaceOp(),
    }] as unknown as SessionEvent[]

    expect(() => new Session(SessionId('seed-exotic-metadata'), seed))
      .toThrow(/losslessly JSON-serializable/)
  })

  it('rejects an exotic seed event shell before spreading erases its prototype', () => {
    class SeedEvent {
      readonly type = 'turn/start' as const
      readonly seq = 0
      readonly time = 1
      readonly data = { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } }
    }
    const seed: SessionEvent[] = [new SeedEvent()]

    expect(() => new Session(SessionId('seed-exotic-shell'), seed))
      .toThrow(/not a plain JSON record/)
  })

  it('accepts a null-prototype seed event shell as a plain JSON record', () => {
    const event = Object.assign(Object.create(null) as Record<string, unknown>, {
      type: 'turn/start' as const,
      seq: 0,
      time: 1,
      data: { turn: 1, trigger: { kind: 'message' as const, source: { kind: 'user' as const } } },
    }) as unknown as SessionEvent

    const session = new Session(SessionId('seed-null-prototype'), [event])

    expect(session.events).toEqual([{ ...event }])
  })

  it('reads a nested seed-metadata getter once and stores its first JSON value', () => {
    let reads = 0
    const surfaceOp = Object.defineProperty({ op: 'replace', end: 0 }, 'start', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 0 : 1n
      },
    })
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      surfaceOp,
    }] as unknown as SessionEvent[]

    const session = new Session(SessionId('seed-unstable-metadata'), seed)
    const event = session.events[0]!
    if (event.type !== 'user/message') throw new Error('test fixture must remain a user/message')

    expect(reads).toBe(1)
    expect(event.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
  })

  it('adds seed context when surface validation throws a non-Error value', () => {
    const originalHasOwn = Object.hasOwn
    const hasOwn = vi.spyOn(Object, 'hasOwn').mockImplementation((object: object, property: PropertyKey): boolean => {
      if ((object as Record<string, unknown>)['op'] === 'replace') throw 'validator failed'
      return originalHasOwn(object, property)
    })
    const seed = [{
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      surfaceOp: { op: 'replace', start: 0, end: 0 },
    }] as unknown as SessionEvent[]

    try {
      expect(() => new Session(SessionId('seed-non-error-metadata-failure'), seed))
        .toThrow('invalid seed event at index 0: invalid surface metadata')
    } finally {
      hasOwn.mockRestore()
    }
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

  it('reads a nested append-data getter once and stores its first JSON value', () => {
    const session = new Session(SessionId('append-nested-drift'))
    let reads = 0
    const data = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 'accepted' : 1n
      },
    })

    const event = session.append('todo/write', data as never)

    expect(reads).toBe(1)
    expect(event.data).toEqual({ value: 'accepted' })
    expect(session.events).toEqual([event])
  })

  it('reads surface metadata accessors once so a validated marker is logged', () => {
    const session = new Session(SessionId('surface-intent-snapshot'))
    let reads = 0
    const intent = {
      get surfaceOp(): 'append' | undefined {
        reads += 1
        return reads === 1 ? 'append' : undefined
      },
    }

    const event = session.append(
      'user/message',
      { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      intent as { surfaceOp: 'append' },
    )

    expect(reads).toBe(1)
    expect(event.surfaceOp).toBe('append')
  })

  it('rejects non-JSON surface metadata before appending the event', () => {
    const session = new Session(SessionId('append-bad-metadata'))

    expect(() => session.append(
      'user/message',
      { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      { surfaceOp: { op: 'replace', start: 1n, end: 2 } } as never,
    )).toThrow(/non-JSON-serializable surface metadata/)
    expect(session.events).toEqual([])
  })

  it('rejects exotic surface metadata before cloning can erase its prototype', () => {
    class ReplaceOp {
      readonly op = 'replace' as const
      readonly start = 0
      readonly end = 0
    }
    const session = new Session(SessionId('append-exotic-metadata'))

    expect(() => session.append(
      'user/message',
      { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      { surfaceOp: new ReplaceOp() },
    )).toThrow(/non-JSON-serializable surface metadata/)
    expect(session.events).toEqual([])
  })

  it('reads a nested append-metadata getter once and stores its first JSON value', () => {
    const session = new Session(SessionId('append-unstable-metadata'))
    let reads = 0
    const surfaceOp = Object.defineProperty({ op: 'replace', end: 0 }, 'start', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 0 : 1n
      },
    })

    const event = session.append(
      'user/message',
      { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      { surfaceOp } as never,
    )

    expect(reads).toBe(1)
    expect(event.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
    expect(session.events).toEqual([event])
  })

  it('rejects invalid plain surface metadata shapes at append', () => {
    const session = new Session(SessionId('append-invalid-surface-shape'))
    const appendRaw = session.append.bind(session) as unknown as (
      type: SessionEventType,
      data: unknown,
      opts?: unknown,
    ) => SessionEvent
    const data = { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }

    expect(() => appendRaw('user/message', data, { surfaceOp: 'invalid' }))
      .toThrow(/invalid surfaceOp/)
    expect(() => appendRaw('user/message', data, {
      surfaceOp: { op: 'replace', start: -1, end: 0 },
    })).toThrow(/invalid replace surfaceOp/)
    expect(() => appendRaw('user/message', data, {
      surfaceOp: 'append',
      sourceEventSeqs: [0, -1],
    })).toThrow(/non-negative safe integers/)
    expect(session.events).toEqual([])
  })

  it('rejects surface metadata on non-surface append and seed events', () => {
    const session = new Session(SessionId('non-surface-metadata'))
    const appendRaw = session.append.bind(session) as unknown as (
      type: SessionEventType,
      data: unknown,
      opts?: unknown,
    ) => SessionEvent

    expect(() => appendRaw(
      'turn/start',
      { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      { surfaceOp: 'append' },
    )).toThrow(/not surface-eligible and cannot carry surface metadata/)
    expect(() => new Session(SessionId('non-surface-metadata-seed'), [{
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      surfaceOp: 'append',
    } as unknown as SessionEvent])).toThrow(/invalid seed event.*not surface-eligible/)
    expect(session.events).toEqual([])
  })

  it('deep-freezes seeded and appended event snapshots', () => {
    const seeded = new Session(SessionId('seed-frozen'), [{
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
    }])
    const seededEvent = seeded.events[0]!
    if (seededEvent.type !== 'turn/start') throw new Error('test fixture must remain a turn/start')
    expect(Object.isFrozen(seededEvent)).toBe(true)
    expect(Object.isFrozen(seededEvent.data)).toBe(true)
    expect(Object.isFrozen(seededEvent.data.trigger)).toBe(true)
    expect(() => { seededEvent.data.turn = 99 }).toThrow(TypeError)

    const appended = new Session(SessionId('append-frozen'))
    const appendedEvent = appended.append('todo/write', {
      todos: [{ content: 'first', status: 'pending' }],
    })
    expect(Object.isFrozen(appendedEvent)).toBe(true)
    expect(Object.isFrozen(appendedEvent.data)).toBe(true)
    expect(Object.isFrozen(appendedEvent.data.todos)).toBe(true)
    expect(Object.isFrozen(appendedEvent.data.todos[0])).toBe(true)
    expect(() => { appendedEvent.data.todos[0]!.content = 'mutated' }).toThrow(TypeError)
  })

  it('returns cached frozen event-array snapshots that do not grow after append', () => {
    const session = new Session(SessionId('events-snapshot'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const before = session.events
    const beforeEvent = before[0]!
    if (beforeEvent.type !== 'turn/start') throw new Error('test fixture must remain a turn/start')

    expect(session.events).toBe(before)
    expect(Object.isFrozen(before)).toBe(true)
    expect(() => { (before as SessionEvent[]).push(beforeEvent) }).toThrow(TypeError)
    expect(() => { beforeEvent.data.turn = 99 }).toThrow(TypeError)

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const after = session.events
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(2)
    expect(after).not.toBe(before)
    expect(session.events).toBe(after)
  })

  it('detaches and freezes an explicitly supplied session header', () => {
    const input = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('header-owned'),
      createdAt: 123,
      cwd: '/accepted',
      parentSession: SessionId('parent'),
      seedLength: 2,
    }

    const session = new Session(SessionId('header-owned'), undefined, input)
    input.cwd = '/caller-mutated'

    expect(session.header).toEqual({
      version: SESSION_FORMAT_VERSION,
      id: 'header-owned',
      createdAt: 123,
      cwd: '/accepted',
      parentSession: 'parent',
      seedLength: 2,
    })
    expect(session.header).not.toBe(input)
    expect(Object.isFrozen(session.header)).toBe(true)
    expect(Reflect.set(session.header, 'cwd', '/published-mutated')).toBe(false)
    expect(Reflect.set(session, 'id', SessionId('redirected'))).toBe(false)
    expect(Reflect.set(session, 'header', input)).toBe(false)
    expect(Object.getOwnPropertyDescriptor(session, 'id')).toMatchObject({
      configurable: false,
      writable: false,
    })
    expect(Object.getOwnPropertyDescriptor(session, 'header')).toMatchObject({
      configurable: false,
      writable: false,
    })
    expect(session.id).toBe('header-owned')
    expect(session.header.cwd).toBe('/accepted')
  })

  it('reads each supplied header field once before validation and publication', () => {
    const reads = { version: 0, id: 0, createdAt: 0, cwd: 0, parentSession: 0, seedLength: 0 }
    const header = {
      get version() { reads.version += 1; return reads.version === 1 ? SESSION_FORMAT_VERSION : 99 },
      get id() { reads.id += 1; return reads.id === 1 ? SessionId('header-once') : SessionId('drifted') },
      get createdAt() { reads.createdAt += 1; return reads.createdAt === 1 ? 123 : Number.NaN },
      get cwd() { reads.cwd += 1; return reads.cwd === 1 ? '/accepted' : 'relative' },
      get parentSession() { reads.parentSession += 1; return reads.parentSession === 1 ? SessionId('parent') : 1n },
      get seedLength() { reads.seedLength += 1; return reads.seedLength === 1 ? 0 : 1n },
    } as unknown as SessionHeader

    const session = new Session(SessionId('header-once'), undefined, header)

    expect(reads).toEqual({ version: 1, id: 1, createdAt: 1, cwd: 1, parentSession: 1, seedLength: 1 })
    expect(session.header).toEqual({
      version: SESSION_FORMAT_VERSION,
      id: 'header-once',
      createdAt: 123,
      cwd: '/accepted',
      parentSession: 'parent',
      seedLength: 0,
    })
  })

  it('rejects an exotic, non-JSON, or mismatched supplied header', () => {
    class ExoticHeader implements SessionHeader {
      readonly version = SESSION_FORMAT_VERSION
      readonly id = SessionId('header-invalid')
      readonly createdAt = 123
    }

    expect(() => new Session(SessionId('header-invalid'), undefined, new ExoticHeader()))
      .toThrow(/not a plain JSON record/)
    expect(() => new Session(SessionId('header-invalid'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('header-invalid'),
      createdAt: 123,
      parentSession: 1n,
    } as unknown as SessionHeader)).toThrow(/not losslessly JSON-serializable/)
    expect(() => new Session(SessionId('header-invalid'), undefined, {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('other'),
      createdAt: 123,
    })).toThrow(/does not match session id/)
  })

  it('rejects invalid scalar fields in an explicitly supplied header', () => {
    const base = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('header-shape'),
      createdAt: 123,
    }
    const cases: Array<{ header: unknown; error: RegExp }> = [
      { header: 1, error: /not a plain JSON record/ },
      { header: null, error: /not a plain JSON record/ },
      { header: { ...base, version: 1 }, error: /header version/ },
      { header: { ...base, createdAt: '123' }, error: /createdAt must be a finite number/ },
      { header: { ...base, cwd: 1 }, error: /header cwd must be a string/ },
      { header: { ...base, cwd: 'relative' }, error: /header cwd must be an absolute path/ },
      { header: { ...base, parentSession: 1 }, error: /header parentSession must be a string/ },
      { header: { ...base, seedLength: '1' }, error: /seedLength must be a non-negative safe integer/ },
      { header: { ...base, seedLength: 0.5 }, error: /seedLength must be a non-negative safe integer/ },
      { header: { ...base, seedLength: -1 }, error: /seedLength must be a non-negative safe integer/ },
    ]

    for (const { header, error } of cases) {
      expect(() => new Session(SessionId('header-shape'), undefined, header as SessionHeader)).toThrow(error)
    }
  })

  it('rejects seed records with invalid fixed-envelope fields', () => {
    const base = {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
    }
    const cases: unknown[] = [
      { ...base, extra: true },
      { ...base, type: 1 },
      { ...base, seq: '0' },
      { ...base, seq: 0.5 },
      { ...base, seq: -1 },
      { ...base, time: '1' },
      { ...base, time: 0.5 },
      { ...base, time: -1 },
      { type: base.type, seq: base.seq, time: base.time },
    ]

    for (const [index, event] of cases.entries()) {
      expect(() => new Session(SessionId(`bad-envelope-${index}`), [event as SessionEvent]))
        .toThrow(/invalid event envelope/)
    }
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

    // The store-owned append observer is module-private. A JavaScript caller
    // may create an unrelated property with the old implementation's name,
    // but cannot suppress the durable event feed.
    expect(Reflect.set(session, 'onAppend', undefined)).toBe(true)
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
    detach() // idempotent: cannot disturb a later same-id lifecycle
    expect(ctx.sessions.get(SessionId('lifecycle'))).toBeUndefined()
  })

  it('captures the accepted id once and prevents simultaneous attachment to two stores', async () => {
    const firstCtx = new Context()
    const secondCtx = new Context()
    await firstCtx.plugin(SessionStore)
    await secondCtx.plugin(SessionStore)
    const session = new Session(SessionId('owned-key'))
    const detachFirst = firstCtx.sessions.enter(session)

    expect(Reflect.set(session, 'id', SessionId('redirected'))).toBe(false)
    expect(() => secondCtx.sessions.enter(session)).toThrow(/already attached to a store/)
    expect(firstCtx.sessions.get(SessionId('owned-key'))).toBe(session)

    detachFirst()
    expect(firstCtx.sessions.get(SessionId('owned-key'))).toBeUndefined()
    const detachSecond = secondCtx.sessions.enter(session)
    expect(secondCtx.sessions.get(SessionId('owned-key'))).toBe(session)
    detachSecond()

    expect(() => firstCtx.sessions.enter({ id: 42 } as unknown as Session)).toThrow(/id must be a string/)
  })

  it('uses an opaque one-session reservation to gate unpublished factory insertion', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const held = ctx.sessions.reserve(SessionId('held-session'))

    expect(() => ctx.sessions.reserve(SessionId('held-session'))).toThrow(/already exists or is reserved/)
    expect(() => ctx.sessions.prepare(SessionId('held-session'))).toThrow(/reserved for unpublished creation/)
    expect(() => ctx.sessions.create(SessionId('held-session'))).toThrow(/reserved for unpublished creation/)
    const session = held.prepare({ meta: { cwd: '/held' } })
    expect(() => held.prepare()).toThrow(/already prepared/)
    expect(() => ctx.sessions.enter(session)).toThrow(/reserved for unpublished creation/)

    const other = ctx.sessions.reserve(SessionId('other-session'))
    expect(() => ctx.sessions.enter(session, other)).toThrow(/does not own this prepared session/)
    expect(() => ctx.sessions.enter(new Session(SessionId('held-session')), held))
      .toThrow(/does not own this prepared session/)

    const detach = ctx.sessions.enter(session, held)
    ctx.sessions.announce(session)
    held.release()
    held.release()
    expect(ctx.sessions.get(SessionId('held-session'))).toBe(session)
    expect(() => ctx.sessions.reserve(SessionId('held-session'))).toThrow(/already exists or is reserved/)
    detach()
    other.release()

    const expired = ctx.sessions.reserve(SessionId('expired-session'))
    expired.release()
    expect(() => expired.prepare()).toThrow(/no longer active/)
    expect(() => ctx.sessions.enter(new Session(SessionId('expired-session')), expired))
      .toThrow(/does not own this prepared session/)
    expect(() => ctx.sessions.reserve(42 as unknown as SessionId)).toThrow(/id must be a string/)
    expect(() => ctx.sessions.prepare(42 as unknown as SessionId)).toThrow(/id must be a string/)

    // Auto-generated ids skip unpublished reservations just as they skip live
    // store entries; no hidden collision can be published later.
    const firstAuto = ctx.sessions.reserve(SessionId('session-1'))
    expect(ctx.sessions.prepare().id).toBe('session-2')
    firstAuto.release()
  })

  it('owns reservations by the calling fiber and rolls back failed ownership registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let held!: import('@deepseek-ai/dsh-session').SessionRegistrationReservation
    let scopedSessions!: SessionStore
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      scopedSessions = inner.sessions
      held = inner.sessions.reserve(SessionId('fiber-held'))
    }, { inject: ['sessions'] }))

    expect(() => ctx.sessions.reserve(SessionId('fiber-held'))).toThrow(/already exists or is reserved/)
    await owner.dispose()
    const reused = ctx.sessions.reserve(SessionId('fiber-held'))
    reused.release()
    held.release() // idempotent after the automatic owner-disposal release

    expect(() => scopedSessions.reserve(SessionId('inactive-owner'))).toThrow(/inactive context/)
    const recovered = ctx.sessions.reserve(SessionId('inactive-owner'))
    recovered.release()
  })

  it('rejects direct and reentrant repeat announcements to preserve one lifecycle pair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let created = 0
    let disposed = 0
    let reentrantError = ''
    ctx.on('session/created', (session) => {
      created += 1
      try {
        ctx.sessions.announce(session)
      } catch (error: unknown) {
        reentrantError = String(error)
      }
    })
    ctx.on('session/disposed', () => { disposed += 1 })

    const session = ctx.sessions.prepare(SessionId('once'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    expect(reentrantError).toMatch(/already announced/)
    expect(() => { ctx.sessions.announce(session) }).toThrow(/already announced/)
    detach()
    expect({ created, disposed }).toEqual({ created: 1, disposed: 1 })
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

  it('reads session options and each metadata field once in prepare()', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const reads = { seed: 0, meta: 0, cwd: 0, parentSession: 0, createdAt: 0, seedLength: 0 }
    const meta = {
      get cwd() { reads.cwd += 1; return reads.cwd === 1 ? '/accepted' : 'relative' },
      get parentSession() { reads.parentSession += 1; return reads.parentSession === 1 ? SessionId('parent') : 1n },
      get createdAt() { reads.createdAt += 1; return reads.createdAt === 1 ? 123 : Number.NaN },
      get seedLength() { reads.seedLength += 1; return reads.seedLength === 1 ? 0 : 1n },
    }
    const options = {
      get seed() { reads.seed += 1; return reads.seed === 1 ? undefined : [] },
      get meta() { reads.meta += 1; return reads.meta === 1 ? meta : undefined },
    } as unknown as CreateSessionOptions

    const session = ctx.sessions.prepare(SessionId('metadata-once'), options)

    expect(reads).toEqual({ seed: 1, meta: 1, cwd: 1, parentSession: 1, createdAt: 1, seedLength: 1 })
    expect(session.header).toEqual({
      version: SESSION_FORMAT_VERSION,
      id: 'metadata-once',
      createdAt: 123,
      cwd: '/accepted',
      parentSession: 'parent',
      seedLength: 0,
    })
  })

  it('rejects exotic metadata before cloning can erase its prototype', async () => {
    class ExoticMeta {
      readonly cwd = '/accepted'
    }
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    expect(() => ctx.sessions.prepare(SessionId('exotic-meta'), { meta: new ExoticMeta() }))
      .toThrow(/session metadata is not a plain JSON record/)
  })

  it('rejects non-JSON and invalid scalar session metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const cases: Array<{ meta: unknown; error: RegExp }> = [
      { meta: 1, error: /metadata is not a plain JSON record/ },
      { meta: { parentSession: 1n }, error: /metadata is not losslessly JSON-serializable/ },
      { meta: { cwd: 1 }, error: /session cwd must be a string/ },
      { meta: { parentSession: 1 }, error: /parentSession must be a string/ },
      { meta: { createdAt: '123' }, error: /createdAt must be a finite number/ },
      { meta: { seedLength: '1' }, error: /seedLength must be a non-negative safe integer/ },
      { meta: { seedLength: 0.5 }, error: /seedLength must be a non-negative safe integer/ },
      { meta: { seedLength: -1 }, error: /seedLength must be a non-negative safe integer/ },
    ]

    for (const [index, { meta, error }] of cases.entries()) {
      expect(() => ctx.sessions.prepare(SessionId(`bad-meta-${index}`), {
        meta: meta as NonNullable<CreateSessionOptions['meta']>,
      })).toThrow(error)
    }
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

  it('pairs a partial session/created announcement with disposal during rollback', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    let threw = false
    const disposed: Session[] = []
    ctx.on('session/disposed', (session) => { disposed.push(session) })
    ctx.on('session/created', () => {
      if (!threw) { threw = true; throw new Error('boom created listener') }
    })

    // The throwing emit must roll the store entry back, not leak it.
    expect(() => ctx.sessions.create(SessionId('fixed'))).toThrow('boom created listener')
    expect(ctx.sessions.get(SessionId('fixed'))).toBeUndefined() // rolled back, not leaked
    expect(disposed.map(session => session.id)).toEqual(['fixed'])

    // A subsequent create of the SAME id succeeds (the already-exists check is
    // not wedged) and its store-owned observer is correctly wired (events observable).
    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => void events.push(event))
    const session = ctx.sessions.create(SessionId('fixed'))
    expect(ctx.sessions.get(SessionId('fixed'))).toBe(session)
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    expect(events).toHaveLength(1)
  })

  it('observes async session/created rejection without rolling back or starving peers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const heard: string[] = []
    ctx.on('session/created', () => Promise.reject(new Error('late creation failure')) as never)
    ctx.on('session/created', (session) => { heard.push(session.id) })

    const session = ctx.sessions.create(SessionId('async-created'))
    await Promise.resolve()
    await Promise.resolve()

    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(heard).toEqual(['async-created'])
    expect(warnings).toEqual([
      'session "async-created": session/created listener rejected: Error: late creation failure',
    ])
  })

  it('contains synchronous and async session/disposed listener failures per observer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const hostile = { [Symbol.toPrimitive]() { throw new Error('cannot stringify') } }
    const printable = { toString: () => 'printable failure' }
    const heard: string[] = []
    ctx.on('session/disposed', () => { throw hostile })
    ctx.on('session/disposed', () => Promise.reject(new Error('async disposed')) as never)
    ctx.on('session/disposed', () => { throw printable })
    ctx.on('session/disposed', (session) => { heard.push(session.id) })

    const unannounced = ctx.sessions.prepare(SessionId('never-announced'))
    const detachUnannounced = ctx.sessions.enter(unannounced)
    detachUnannounced()
    expect(heard).toEqual([])

    const announced = ctx.sessions.prepare(SessionId('contained-disposal'))
    const detach = ctx.sessions.enter(announced)
    ctx.sessions.announce(announced)
    expect(() => { detach() }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(heard).toEqual(['contained-disposal'])
    expect(warnings).toEqual([
      'session "contained-disposal": session/disposed listener threw: <unrenderable thrown value>',
      'session "contained-disposal": session/disposed listener threw: printable failure',
      'session "contained-disposal": session/disposed listener rejected: Error: async disposed',
    ])
  })
})

describe('todo/write event', () => {
  it('appends the whole-list snapshot and isolates the log from later mutation', () => {
    const session = new Session(SessionId('t1'))
    const todos: TodoItem[] = [
      { content: 'plan the work', status: 'in_progress' },
      { content: 'write the code', status: 'pending' },
    ]
    session.append('todo/write', { todos })

    const event = session.events.findLast(e => e.type === 'todo/write')!
    expect(event.type).toBe('todo/write')
    expect(event.data.todos).toEqual(todos)

    // The append snapshots its input: mutating the caller's array afterward must
    // not change what the log holds (the durable-source-of-truth contract).
    todos.push({ content: 'sneak in', status: 'pending' })
    todos[0]!.status = 'completed'
    expect(event.data.todos).toEqual([
      { content: 'plan the work', status: 'in_progress' },
      { content: 'write the code', status: 'pending' },
    ])
  })

  it('is last-write-wins: the current list is the most recent todo/write', () => {
    const session = new Session(SessionId('t2'))
    session.append('todo/write', { todos: [{ content: 'first', status: 'pending' }] })
    session.append('todo/write', { todos: [
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
    ] })

    const current = session.events.findLast(e => e.type === 'todo/write')!.data.todos
    expect(current).toEqual([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
    ])
  })

  it('is NOT a surface event: it produces no derived message and joins no surface node', () => {
    const session = new Session(SessionId('t3'))
    session.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const before = session.deriveMessages().length
    session.append('todo/write', { todos: [{ content: 'a task', status: 'pending' }] })
    // The todo event must not add a message to the derived history…
    expect(session.deriveMessages()).toHaveLength(before)
    // …and must not appear on the surface linked list.
    expect(session.surface.nodes.some(node => node.seq === session.seq - 1)).toBe(false)
  })

  it('round-trips through a seeded replay identically (durable, no surfaceOp needed)', () => {
    const original = new Session(SessionId('t4'))
    original.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    original.append('todo/write', { todos: [{ content: 'only', status: 'completed' }] })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Seeding a non-surface event with no surfaceOp must not throw.
    const replayed = new Session(SessionId('t4-replay'), [...original.events])
    expect(replayed.events.findLast(e => e.type === 'todo/write')!.data.todos)
      .toEqual([{ content: 'only', status: 'completed' }])
    expect(replayed.seq).toBe(original.seq)
  })
})
