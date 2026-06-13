/**
 * Property-based tests for the Session event log (RFC 001 → ADR 0013).
 *
 * Generates arbitrary event logs and asserts the derivation invariants the
 * agent loop and replay depend on: deriveMessages is deterministic and
 * replay-from-seed reproduces it; seq is strictly monotonic; non-message
 * events never affect derived history.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'

type Appendable = { [T in SessionEventType]: { type: T; data: SessionEventMap[T] } }[SessionEventType]

const textContentArb = fc.array(
  fc.record({ type: fc.constant<'text'>('text'), text: fc.string() }),
  { maxLength: 3 },
)

// A message-producing event (these DO affect derived history).
const messageEventArb: fc.Arbitrary<Appendable> = fc.oneof(
  textContentArb.map((content): Appendable => ({ type: 'user/message', data: { content, source: { kind: 'user' } } })),
  textContentArb.map((content): Appendable => ({ type: 'assistant/message', data: { turn: 1, step: 1, content } })),
  fc.record({ id: fc.string({ minLength: 1 }), content: textContentArb, isError: fc.boolean() })
    .map((r): Appendable => ({ type: 'tool/result', data: { turn: 1, step: 1, callId: CallId(r.id), content: r.content, isError: r.isError } })),
)

// A non-message event (trace/replay data — must NOT affect derived history).
const nonMessageEventArb: fc.Arbitrary<Appendable> = fc.oneof(
  fc.constant<Appendable>({ type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } }),
  fc.constant<Appendable>({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  fc.constant<Appendable>({ type: 'step/start', data: { turn: 1, step: 1 } }),
  fc.constant<Appendable>({ type: 'step/end', data: { turn: 1, step: 1 } }),
  fc.string().map((text): Appendable => ({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } } })),
  fc.constant<Appendable>({ type: 'usage', data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } }),
  fc.constant<Appendable>({ type: 'error', data: { turn: 1, step: 1, message: 'x' } }),
)

const anyEventArb = fc.oneof(messageEventArb, nonMessageEventArb)
const logArb = fc.array(anyEventArb, { maxLength: 25 })

let counter = 0
function build(events: Appendable[]): Session {
  const session = new Session(SessionId(`prop-${counter++}`))
  for (const e of events) session.append(e.type, e.data)
  return session
}

describe('Session properties', () => {
  it('deriveMessages is deterministic (same log → identical derivation)', () => {
    fc.assert(fc.property(logArb, (events) => {
      const a = build(events)
      expect(a.deriveMessages()).toEqual(a.deriveMessages())
    }))
  })

  it('seq is strictly monotonic and zero-based contiguous', () => {
    fc.assert(fc.property(logArb, (events) => {
      const session = build(events)
      session.events.forEach((event, i) => { expect(event.seq).toBe(i) })
      expect(session.seq).toBe(events.length)
    }))
  })

  it('replay-from-seed reproduces the derivation identically', () => {
    fc.assert(fc.property(logArb, (events) => {
      const original = build(events)
      const replayed = new Session(SessionId(`replay-${counter++}`), [...original.events])
      expect(replayed.deriveMessages()).toEqual(original.deriveMessages())
      expect(replayed.seq).toBe(original.seq)
    }))
  })

  it('non-message events never affect derived history', () => {
    fc.assert(fc.property(
      fc.array(messageEventArb, { maxLength: 12 }),
      fc.array(nonMessageEventArb, { maxLength: 12 }),
      (messages, noise) => {
        // The same message events, with and without interleaved noise, derive
        // the same history (noise is inserted at arbitrary positions).
        const clean = build(messages).deriveMessages()
        const interleaved: Appendable[] = []
        const maxLen = Math.max(messages.length, noise.length)
        for (let i = 0; i < maxLen; i++) {
          if (i < noise.length) interleaved.push(noise[i]!)
          if (i < messages.length) interleaved.push(messages[i]!)
        }
        const withNoise = build(interleaved).deriveMessages()
        expect(withNoise).toEqual(clean)
      },
    ))
  })

  it('every derived message has a known role and decoupled content', () => {
    fc.assert(fc.property(logArb, (events) => {
      const session = build(events)
      const messages = session.deriveMessages()
      const before = structuredClone(session.events)
      for (const m of messages) {
        expect(['user', 'assistant', 'system']).toContain(m.role)
        // Mutating derived content must not touch the log (append-only).
        m.content.push({ type: 'text', text: 'mutation' })
      }
      expect(session.events).toEqual(before)
    }))
  })
})
