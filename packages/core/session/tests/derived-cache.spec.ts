/**
 * Derived-message cache tests: the session projects each surface node exactly
 * once (O(new nodes) per call), rebuilds on a surface rewrite (replace /
 * invalidate — the replaceGeneration signal), returns a fresh array snapshot
 * per call over shared frozen messages, and stays deep-equal to a from-scratch
 * replay derivation at every step — the incremental==scratch property the
 * reconstructability RFC's invariant enforces in dev at request time.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

function userText(session: Session, text: string): void {
  session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })
}

/** From-scratch oracle: replay the log into a fresh session and derive. */
function scratch(session: Session): unknown {
  return new Session(SessionId(`${session.id}-scratch-${session.seq}`), [...session.events]).deriveMessages()
}

describe('derived-message cache', () => {
  it('stays deep-equal to a from-scratch replay derivation as the log grows', () => {
    const session = new Session(SessionId('cache-grow'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    userText(session, 'one')
    expect(session.deriveMessages()).toEqual(scratch(session))
    userText(session, 'two')
    session.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'reply' }] }, { surfaceOp: 'append' })
    expect(session.deriveMessages()).toEqual(scratch(session))
    // An empty-content assistant/message (usage host) projects to nothing.
    session.append('assistant/message', { turn: 1, step: 2, content: [], usage: { inputTokens: 1, outputTokens: 0 } }, { surfaceOp: 'append' })
    expect(session.deriveMessages()).toEqual(scratch(session))
  })

  it('rebuilds on a surface replace and still matches scratch', () => {
    const session = new Session(SessionId('cache-replace'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    userText(session, 'one')
    userText(session, 'two')
    const beforeReplace = session.deriveMessages()
    expect(beforeReplace).toHaveLength(2)

    const nodes = session.surface.nodes
    session.append('context/message', {
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' },
    }, { surfaceOp: { op: 'replace', start: nodes[0]!.seq, end: nodes[1]!.seq }, sourceEventSeqs: [nodes[0]!.seq, nodes[1]!.seq] })

    expect(session.deriveMessages()).toHaveLength(1)
    expect(session.deriveMessages()).toEqual(scratch(session))
    // The array a caller took before the replace is untouched.
    expect(beforeReplace).toHaveLength(2)
  })

  it('returns a fresh array per call: later appends never grow a held snapshot', () => {
    const session = new Session(SessionId('cache-snapshot'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    userText(session, 'one')
    const first = session.deriveMessages()
    userText(session, 'two')
    const second = session.deriveMessages()
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(2)
    // Shared projection objects: the same frozen message instance, once ever.
    expect(second[0]).toBe(first[0])
    expect(Object.isFrozen(first[0])).toBe(true)
  })

  it('rebuilds after surface.invalidate() (the generation covers wholesale rebuilds too)', () => {
    const session = new Session(SessionId('cache-invalidate'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    userText(session, 'one')
    const before = session.deriveMessages()
    session.surface.invalidate()
    const after = session.deriveMessages()
    expect(after).toEqual(before)
    // A rebuild re-projects: fresh objects, same values.
    expect(after[0]).not.toBe(before[0])
  })
})

describe('Session.deriveEventMessage — the per-event projection', () => {
  it('projects one appended event exactly as the full derivation projects its node', () => {
    const session = new Session(SessionId('per-event'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const event = session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    // The fold path (deriveMessages) and the per-event path share the
    // projection, so an external reconstructor cannot disagree with the cache.
    expect(session.deriveEventMessage(event)).toEqual(session.deriveMessages().at(-1))
  })

  it('clones content off the log: the projection never aliases the logged event', () => {
    const session = new Session(SessionId('per-event-clone'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const event = session.append('user/message', { content: [{ type: 'text', text: 'orig' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const message = session.deriveEventMessage(event)!
    expect(message.content).not.toBe(event.data.content)
    // deriveEventMessage returns an unfrozen clone (the cache freezes ITS
    // copies); mutating it must not reach the log.
    ;(message.content[0] as { text: string }).text = 'mutated'
    expect(session.deriveMessages().at(-1)!.content).toEqual([{ type: 'text', text: 'orig' }])
  })

  it('projects null for events that produce no message (boundaries, empty assistant)', () => {
    const session = new Session(SessionId('per-event-null'))
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    const boundary = session.append('step/start', { turn: 1, step: 1 })
    expect(session.deriveEventMessage(boundary)).toBeNull()
    const empty = session.append('assistant/message', { turn: 1, step: 1, content: [] }, { surfaceOp: 'append' })
    expect(session.deriveEventMessage(empty)).toBeNull()
  })
})
