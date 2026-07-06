/**
 * recordRequestHeader unit tests: exactly one of four things per request —
 * an 'initial' snapshot (log has no header yet), a 'resume' snapshot (fresh
 * loop instance over a log that has one), nothing (header unchanged), a
 * round-tripping delta, or a 'fallback' snapshot when the delta encoding
 * cannot express the change (pure tool reordering).
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { createTransmissionLog, recordRequestHeader } from '../src/request-log.ts'

function tool(name: string, description = 'd'): ToolSchema {
  return { name, description, parameters: { type: 'object' } }
}

function openSession(id: string): Session {
  const session = new Session(SessionId(id))
  session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  return session
}

function headerEvents(session: Session): SessionEvent[] {
  return session.events.filter(e => e.type === 'request/header' || e.type === 'request/header-delta')
}

describe('recordRequestHeader', () => {
  it("anchors a new conversation with an 'initial' snapshot, then logs nothing while unchanged", () => {
    const session = openSession('rl-initial')
    const state = createTransmissionLog()
    const header = canonicalHeader({ config: { model: 'm' }, system: 's', tools: [tool('t')] })

    recordRequestHeader(session, state, header)
    const [first] = headerEvents(session)
    expect(first?.type === 'request/header' && first.data.reason).toBe('initial')

    recordRequestHeader(session, state, header)
    expect(headerEvents(session)).toHaveLength(1)
  })

  it("anchors a fresh loop instance over an anchored log with a 'resume' snapshot, even unchanged", () => {
    const session = openSession('rl-resume')
    const header = canonicalHeader({ config: { model: 'm' }, system: 's' })
    recordRequestHeader(session, createTransmissionLog(), header)

    // A second instance (process restart / fork): the boundary itself is a
    // recorded fact — snapshot appended even though the header is identical.
    recordRequestHeader(session, createTransmissionLog(), header)
    const events = headerEvents(session)
    expect(events).toHaveLength(2)
    expect(events[1]?.type === 'request/header' && events[1].data.reason).toBe('resume')
  })

  it('logs a round-tripping delta for a mid-run change, and the fold reproduces the header', () => {
    const session = openSession('rl-delta')
    const state = createTransmissionLog()
    const first = canonicalHeader({ config: { model: 'm' }, system: 'a\nb', tools: [tool('t')] })
    recordRequestHeader(session, state, first)

    const second = canonicalHeader({ config: { model: 'm' }, system: 'a\nc', tools: [tool('t'), tool('u')] })
    recordRequestHeader(session, state, second)
    const events = headerEvents(session)
    expect(events).toHaveLength(2)
    expect(events[1]?.type).toBe('request/header-delta')
    expect(session.requestHeader()).toEqual(second)
  })

  it("records a change the delta cannot express (pure reordering) as a 'fallback' snapshot", () => {
    const session = openSession('rl-fallback')
    const state = createTransmissionLog()
    const first = canonicalHeader({ config: { model: 'm' }, tools: [tool('a'), tool('b')] })
    recordRequestHeader(session, state, first)

    const reordered = canonicalHeader({ config: { model: 'm' }, tools: [tool('b'), tool('a')] })
    recordRequestHeader(session, state, reordered)
    const events = headerEvents(session)
    expect(events).toHaveLength(2)
    expect(events[1]?.type === 'request/header' && events[1].data.reason).toBe('fallback')
    // The fold still lands on the exact header — deltas are an encoding
    // optimization, never a correctness dependency.
    expect(session.requestHeader()).toEqual(reordered)
  })
})
