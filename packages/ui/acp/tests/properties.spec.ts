/**
 * Property-based protocol-shape tests for the ACP update stream (RFC 001 →
 * ADR 0013 precedent). Fuzz arbitrary harness `SessionEvent` sequences through
 * the pure `streamSessionEventUpdate` translator and assert the invariants an
 * ACP client relies on:
 *
 *  - every emitted update is a legal `SessionUpdate` variant;
 *  - a `tool_call_update` for a given id is never emitted before a `tool_call`
 *    for that id (the client must see the pending call before its completion);
 *  - the translator is a pure function of the event (same event → same updates),
 *    so live streaming and `session/load` replay produce identical streams.
 *
 * Pure-function fuzzing (no live loop) keeps these deterministic — a failure is
 * a real finding, not timing noise.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { streamSessionEventUpdate } from '../src/index.ts'

const LEGAL_UPDATE_KINDS = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
])

/**
 * Build a WELL-FORMED harness event sequence: a list of "actions" where a tool
 * result can only reference a call already opened earlier. This mirrors what
 * the loop actually appends (tool/call always precedes its tool/result), so the
 * ordering invariant is asserted over realistic logs, not arbitrary noise.
 */
type Action =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'call'; id: string; name: string }
  | { kind: 'result'; idx: number; isError: boolean }
  | { kind: 'ignored' }

function actionsArb(): fc.Arbitrary<Action[]> {
  const action: fc.Arbitrary<Action> = fc.oneof(
    fc.string().map((text): Action => ({ kind: 'text', text })),
    fc.string().map((text): Action => ({ kind: 'reasoning', text })),
    fc.record({ id: fc.string({ minLength: 1 }), name: fc.string() }).map(({ id, name }): Action => ({ kind: 'call', id, name })),
    fc.record({ idx: fc.nat(), isError: fc.boolean() }).map(({ idx, isError }): Action => ({ kind: 'result', idx, isError })),
    fc.constant<Action>({ kind: 'ignored' }),
  )
  return fc.array(action, { maxLength: 30 })
}

/** Lower well-formed actions into a harness event sequence. */
function actionsToEvents(actions: Action[]): SessionEvent[] {
  const events: SessionEvent[] = []
  const openCalls: string[] = []
  for (const a of actions) {
    switch (a.kind) {
      case 'text':
        events.push({ type: 'assistant/chunk', seq: 0, time: 0, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: a.text } } })
        break
      case 'reasoning':
        events.push({ type: 'assistant/chunk', seq: 0, time: 0, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: a.text } } })
        break
      case 'call':
        openCalls.push(a.id)
        events.push({ type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: CallId(a.id), name: a.name, arguments: '{}' } })
        break
      case 'result': {
        // Only emit a result for an already-opened call (well-formedness).
        if (openCalls.length === 0) break
        const id = openCalls[a.idx % openCalls.length]!
        events.push({ type: 'tool/result', seq: 0, time: 0, data: { turn: 1, step: 1, callId: CallId(id), content: [], isError: a.isError } })
        break
      }
      case 'ignored':
        events.push({ type: 'turn/end', seq: 0, time: 0, data: { turn: 1, reason: { kind: 'completed' } } })
        break
    }
  }
  return events
}

function runStream(events: SessionEvent[]): SessionNotification['update'][] {
  const out: SessionNotification['update'][] = []
  for (const event of events) streamSessionEventUpdate(SessionId('s1'), event, n => out.push(n.update))
  return out
}

describe('ACP update-stream invariants (property-based)', () => {
  it('every emitted update is a legal SessionUpdate variant', () => {
    fc.assert(fc.property(actionsArb(), (actions) => {
      for (const update of runStream(actionsToEvents(actions))) {
        expect(LEGAL_UPDATE_KINDS.has(update.sessionUpdate)).toBe(true)
      }
    }))
  })

  it('never emits a tool_call_update for an id before that id\'s tool_call', () => {
    fc.assert(fc.property(actionsArb(), (actions) => {
      const seenCall = new Set<string>()
      for (const update of runStream(actionsToEvents(actions))) {
        if (update.sessionUpdate === 'tool_call') {
          seenCall.add(update.toolCallId)
        } else if (update.sessionUpdate === 'tool_call_update') {
          expect(seenCall.has(update.toolCallId)).toBe(true)
        }
      }
    }))
  })

  it('is a pure function of the event (replay equals live)', () => {
    fc.assert(fc.property(actionsArb(), (actions) => {
      const events = actionsToEvents(actions)
      expect(runStream(events)).toEqual(runStream(events))
    }))
  })
})
