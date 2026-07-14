import { describe, expect, it } from 'vitest'
import type { SessionEvent, SurfaceEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'
import { Session, SessionId, foldSurface, isSurfaceEligibleType, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'

/** Build a minimal session with turn boundaries and a single user message. */
function surfaceSession(): Session {
  const s = new Session(SessionId('ss'))
  s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  s.append('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return s
}

describe('SurfaceManager', () => {
  it('shares exact nodes and nested replacement ranges with foldSurface', () => {
    const s = new Session(SessionId('shared-fold'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'summary' }] }, { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] })
    s.append('assistant/message', { turn: 1, step: 2, content: [{ type: 'text', text: 'summary 2' }] }, { surfaceOp: { op: 'replace', start: 2, end: 1 }, sourceEventSeqs: [2, 1] })

    const folded = foldSurface(s.events)
    expect(folded.nodes).toEqual(s.surface.nodes)
    expect(folded.replacements).toEqual([
      { seq: 2, start: 0, end: 0, shadowedSeqs: [0] },
      { seq: 3, start: 2, end: 1, shadowedSeqs: [2, 1] },
    ])
    folded.nodes[0]!.next = 99
    folded.replacements[0]!.shadowedSeqs.push(99)
    expect(s.surface.nodes).toEqual([{ seq: 3, prev: null, next: null }])
    expect(foldSurface(s.events).replacements[0]!.shadowedSeqs).toEqual([0])
  })

  it('does not retain fold-only replacement history in incremental state', () => {
    const s = new Session(SessionId('incremental-state'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'b' }] }, { surfaceOp: { op: 'replace', start: 0, end: 0 } })

    expect(s.surface.nodes).toEqual([{ seq: 1, prev: null, next: null }])
    const manager = s.surface as unknown as { _state: object }
    expect(Object.hasOwn(manager._state, 'replacements')).toBe(false)
    expect(foldSurface(s.events).replacements).toEqual([
      { seq: 1, start: 0, end: 0, shadowedSeqs: [0] },
    ])
  })

  it('foldSurface reports the same invalid replacement failures as the incremental manager', () => {
    const s = new Session(SessionId('shared-fold-invalid'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: { op: 'replace', start: 42, end: 0 }, sourceEventSeqs: [0] })

    expect(() => foldSurface(s.events)).toThrow(/start seq 42 not found/)
    expect(() => s.surface.nodes).toThrow(/start seq 42 not found/)
  })

  it('foldSurface rejects a surface-eligible event without its mandatory marker', () => {
    const malformed: SessionEvent = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { content: [{ type: 'text', text: 'hidden' }], source: { kind: 'user' } },
    }

    expect(() => foldSurface([malformed]))
      .toThrow(/surface event "user\/message" \(seq 0\) carries no surfaceOp marker/)
  })

  it('rebuilds a linked list from surfaceOp: append markers', () => {
    const s = surfaceSession()
    const nodes = s.surface.nodes
    // Only the user/message and assistant/message carry surfaceOp: 'append'.
    // The turn boundaries do not have surface markers.
    expect(nodes.length).toBe(2)
    expect(nodes[0]!.seq).toBe(1) // user/message (turn/start is seq 0)
    expect(nodes[0]!.prev).toBeNull()
    expect(nodes[0]!.next).toBe(2) // assistant/message (seq 2)
    expect(nodes[1]!.seq).toBe(2)
    expect(nodes[1]!.prev).toBe(1)
    expect(nodes[1]!.next).toBeNull()
  })

  it('invalidate resets to full rebuild', () => {
    const s = surfaceSession()
    expect(s.surface.nodes.length).toBe(2)
    // After invalidate, the surface should rebuild from scratch on next access.
    ;(s.surface).invalidate()
    expect(s.surface.nodes.length).toBe(2) // same result, but rebuilt
  })

  it('empty surface yields empty nodes', () => {
    const s = new Session(SessionId('empty'))
    // Only turn boundaries, no surface nodes.
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(s.surface.nodes.length).toBe(0)
    // deriveMessages returns empty array
    expect(s.deriveMessages()).toEqual([])
  })

  it('picks up new events incrementally (delta processing)', () => {
    const s = surfaceSession()
    expect(s.surface.nodes.length).toBe(2)
    // Append another surface node
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }, { surfaceOp: 'append' })
    expect(s.surface.nodes.length).toBe(3)
    expect(s.surface.nodes[2]!.seq).toBe(4) // seq 4: after turn/end at seq 3
    expect(s.surface.nodes[2]!.prev).toBe(2)
    expect(s.surface.nodes[1]!.next).toBe(4)
  })

  it('replays identically from a seeded log with surface markers', () => {
    const original = surfaceSession()
    original.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false }, { surfaceOp: 'append' })
    const replayed = new Session(SessionId('replay'), [...original.events])
    // Surface rebuilds from the seeded log's markers.
    expect(replayed.surface.nodes.map(n => n.seq)).toEqual([1, 2, 4])
    expect(replayed.deriveMessages()).toEqual(original.deriveMessages())
  })

  it('rebuild with replace operation splices out shadowed nodes', () => {
    const s = surfaceSession()
    // Replace surface seqs 1 (user) and 2 (assistant) with the summary.
    s.append('assistant/message',
      { turn: 2, step: 1, content: [{ type: 'text', text: 'summary' }] },
      { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] },
    )
    expect(s.surface.nodes.length).toBe(1)
    expect(s.surface.nodes[0]!.seq).toBe(4) // seq of the compaction marker
    expect(s.surface.nodes[0]!.prev).toBeNull()
    expect(s.surface.nodes[0]!.next).toBeNull()
  })

  it('replace with both ends at real nodes splices only the range', () => {
    const s = new Session(SessionId('range'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 0
    s.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 1
    s.append('user/message', { content: [{ type: 'text', text: 'c' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    // Replace seq 0 through 1 inclusive: shadow a and b, keep c.
    s.append('assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'summary' }] },
      { surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1] },
    ) // seq 3
    expect(s.surface.nodes.map(n => n.seq)).toEqual([3, 2])
    // Links: 3 ↔ 2
    expect(s.surface.nodes[0]!.prev).toBeNull()
    expect(s.surface.nodes[0]!.next).toBe(2)
    expect(s.surface.nodes[1]!.prev).toBe(3)
    expect(s.surface.nodes[1]!.next).toBeNull()
  })

  it('single-node replacement (start === end)', () => {
    const s = new Session(SessionId('single'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 0
    s.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 1
    // Replace only seq 1 (single node).
    s.append('assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'x' }] },
      { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] },
    ) // seq 2
    expect(s.surface.nodes.map(n => n.seq)).toEqual([0, 2])
    expect(s.surface.nodes[0]!.next).toBe(2)
    expect(s.surface.nodes[1]!.prev).toBe(0)
  })

  it('throws when replace start is not found', () => {
    const s = new Session(SessionId('bad-start'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 0
    s.append('assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'y' }] },
      { surfaceOp: { op: 'replace', start: 5, end: 0 }, sourceEventSeqs: [5, 0] },
    )
    expect(() => s.surface.nodes).toThrow(/surface replace: start seq 5 not found/)
  })

  it('throws when replace end is not found', () => {
    const s = new Session(SessionId('bad-end'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 0
    s.append('assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'y' }] },
      { surfaceOp: { op: 'replace', start: 0, end: 99 }, sourceEventSeqs: [0] },
    )
    expect(() => s.surface.nodes).toThrow(/surface replace: end seq 99 not found/)
  })

  it('throws when start is after end', () => {
    const s = new Session(SessionId('reversed'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 0
    s.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 1
    // start=1, end=0 would be reversed order.
    s.append('assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'y' }] },
      { surfaceOp: { op: 'replace', start: 1, end: 0 }, sourceEventSeqs: [1, 0] },
    )
    expect(() => s.surface.nodes).toThrow(/start seq 1.*after end seq 0/)
  })

  it('sourceEventSeqs is snapshot so caller mutation does not affect logged event', () => {
    const s = new Session(SessionId('immutable'))
    const sources = [10, 20]
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'h' }] }, { surfaceOp: 'append', sourceEventSeqs: sources })
    // Mutate caller's array after append.
    sources.push(30)
    sources[0] = 99
    const logged = s.events[0]! as SurfaceEvent
    expect(logged.sourceEventSeqs).toEqual([10, 20])
  })

  it('replace starting at non-head position links to previous node correctly', () => {
    const s = new Session(SessionId('mid-replace'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 0
    s.append('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 1
    s.append('user/message', { content: [{ type: 'text', text: 'c' }], source: { kind: 'user' } }, { surfaceOp: 'append' }) // seq 2
    // Replace the middle node (seq 1) only, keeping seq 0 and seq 2.
    s.append('assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'x' }] },
      { surfaceOp: { op: 'replace', start: 1, end: 1 }, sourceEventSeqs: [1] },
    ) // seq 3
    expect(s.surface.nodes.map(n => n.seq)).toEqual([0, 3, 2])
    // Links: 0 → 3 → 2
    expect(s.surface.nodes[0]!.prev).toBeNull()
    expect(s.surface.nodes[0]!.next).toBe(3)
    expect(s.surface.nodes[1]!.prev).toBe(0)
    expect(s.surface.nodes[1]!.next).toBe(2)
    expect(s.surface.nodes[2]!.prev).toBe(3)
    expect(s.surface.nodes[2]!.next).toBeNull()
  })

  it('surfaceOp replace object is snapshot so caller mutation is isolated', () => {
    const s = new Session(SessionId('immutable-op'))
    s.append('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const op = { op: 'replace' as const, start: 0, end: 0 }
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 's' }] }, { surfaceOp: op, sourceEventSeqs: [0] })
    // Mutate caller's object after append.
    op.start = 99
    const logged = s.events[1]! as SurfaceEvent
    expect(logged.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 })
  })
})

describe('deriveMessages with surface', () => {
  it('uses the surface path when surface markers are present', () => {
    const s = surfaceSession()
    const messages = s.deriveMessages()
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.content[0]).toMatchObject({ type: 'text', text: 'hi' })
  })

  it('surface path skips non-surface events (chunks, boundaries)', () => {
    const s = new Session(SessionId('filter'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } })
    s.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'i' } })
    s.append('user/message', { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Chunks and boundaries are NOT in the surface, so only 2 messages.
    expect(s.deriveMessages()).toHaveLength(2)
  })

  it('deriveMessages via surface respects replace (shadowed nodes are excluded)', () => {
    const s = new Session(SessionId('compacted'))
    s.append('user/message', { content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'compacted' }] }, { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] })
    // Only the compaction node is visible.
    const messages = s.deriveMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text', text: 'compacted' })
  })

  it('context/message and steering/message appear on surface', () => {
    const s = new Session(SessionId('ctx'))
    s.append('context/message', { content: [{ type: 'text', text: 'file changed' }], source: { kind: 'plugin', plugin: 'watcher' } }, { surfaceOp: 'append' })
    s.append('steering/message', { turn: 1, content: [{ type: 'text', text: 'focus' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const messages = s.deriveMessages()
    expect(messages).toHaveLength(2)
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text', text: '<context source="plugin">' })
    expect(messages[1]!.content[0]).toMatchObject({ type: 'text', text: '<steering source="user">' })
  })
})

describe('Session.append surface opts', () => {
  it('records sourceEventSeqs and surfaceOp on the event', () => {
    const s = new Session(SessionId('opts'))
    const event = s.append('assistant/message',
      { turn: 1, step: 1, content: [{ type: 'text', text: 'h' }] },
      { surfaceOp: 'append', sourceEventSeqs: [3, 5, 7] },
    )
    expect(event.sourceEventSeqs).toEqual([3, 5, 7])
    expect(event.surfaceOp).toBe('append')
    // The logged event matches the returned event.
    expect((s.events[0]! as SurfaceEvent).sourceEventSeqs).toEqual([3, 5, 7])
    expect((s.events[0]! as SurfaceEvent).surfaceOp).toBe('append')
  })

  it('deriveMessages skips a surface node that derives to null (empty assistant/message)', () => {
    // An empty-content assistant/message is surface-eligible (it can host usage)
    // but _deriveOneMessage returns null for it, so the surface derivation path's
    // null-check is exercised — the node is on the surface yet produces no message.
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, content: [] }, surfaceOp: 'append' },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const s = new Session(SessionId('nomessage'), seed)
    // The empty assistant/message is on the surface but _deriveOneMessage returns null for it.
    expect(s.deriveMessages()).toHaveLength(0)
  })

  it('a non-surface event carries no surface fields', () => {
    const s = new Session(SessionId('noopts'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect((s.events[0] as SessionEvent<SurfaceEventType>).sourceEventSeqs).toBeUndefined()
    expect((s.events[0] as SessionEvent<SurfaceEventType>).surfaceOp).toBeUndefined()
  })

  it('surfaceOp primitives are not cloned (they are immutable)', () => {
    const s = new Session(SessionId('prim'))
    const event = s.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append' })
    // The string 'append' is a primitive — identity-preserving is fine.
    expect(event.surfaceOp).toBe('append')
  })

  it('isSurfaceEvent rejects a surface-eligible type missing its surfaceOp marker', () => {
    // A raw event (not built via append, which mandates the marker) of a
    // surface-eligible type but with no surfaceOp must NOT narrow to a
    // SurfaceEvent — it would otherwise be silently dropped from the surface.
    const noMarker: SessionEvent = {
      type: 'user/message', seq: 0, time: 1,
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    }
    expect(isSurfaceEvent(noMarker)).toBe(false)
    // A non-surface type is rejected too (the type gate).
    const boundary: SessionEvent = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }
    expect(isSurfaceEvent(boundary)).toBe(false)
    // A properly-marked surface event narrows.
    const marked = { ...noMarker, surfaceOp: 'append' } as SurfaceEvent
    expect(isSurfaceEvent(marked)).toBe(true)
  })
})

describe('surface type guards', () => {
  it('isSurfaceEligibleType is true only for message-producing types', () => {
    expect(isSurfaceEligibleType('user/message')).toBe(true)
    expect(isSurfaceEligibleType('assistant/message')).toBe(true)
    expect(isSurfaceEligibleType('tool/result')).toBe(true)
    expect(isSurfaceEligibleType('context/message')).toBe(true)
    expect(isSurfaceEligibleType('steering/message')).toBe(true)
    expect(isSurfaceEligibleType('turn/start')).toBe(false)
    expect(isSurfaceEligibleType('assistant/chunk')).toBe(false)
  })

  it('isSurfaceEvent narrows a fully-formed surface event', () => {
    const s = surfaceSession()
    const userMessage = s.events.find(e => e.type === 'user/message')!
    expect(isSurfaceEvent(userMessage)).toBe(true)
  })

  it('isSurfaceEvent rejects a non-surface-eligible type', () => {
    const s = surfaceSession()
    const turnStart = s.events.find(e => e.type === 'turn/start')!
    expect(isSurfaceEvent(turnStart)).toBe(false)
  })

  it('isSurfaceEvent rejects a surface-eligible type missing its surfaceOp marker', () => {
    // A surface-eligible type whose mandatory surfaceOp is absent — the state a
    // seed/load log can carry before the marker is validated. surfaceOp is
    // optional on SessionEvent, so this is a representable runtime value.
    const markerless: SessionEvent = {
      type: 'user/message',
      seq: 0,
      time: 0,
      data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    }
    expect(isSurfaceEligibleType(markerless.type)).toBe(true)
    expect(isSurfaceEvent(markerless)).toBe(false)
  })
})

describe('SurfaceManager.replaceGeneration', () => {
  it('folds the pending log delta on access and counts replaces and invalidations', () => {
    const s = new Session(SessionId('gen'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('user/message', { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('user/message', { content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    // Read the generation FIRST — before nodes — so the getter itself folds
    // the pending delta rather than piggybacking on a nodes read.
    expect(s.surface.replaceGeneration).toBe(0)

    const nodes = s.surface.nodes
    s.append('context/message', {
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' },
    }, { surfaceOp: { op: 'replace', start: nodes[0]!.seq, end: nodes[1]!.seq }, sourceEventSeqs: [nodes[0]!.seq, nodes[1]!.seq] })
    expect(s.surface.replaceGeneration).toBe(1)

    // invalidate() is a rewrite too: the generation moves forward (and the
    // refold re-counts the replace), never backwards.
    s.surface.invalidate()
    expect(s.surface.replaceGeneration).toBeGreaterThan(1)
  })
})
