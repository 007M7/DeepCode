import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { isStepAlignedStart, isStepAlignedEnd } from '../src/index.ts'
import type { SessionEvent } from '../src/index.ts'

/**
 * Unit coverage for the step-alignment predicates. They decide whether a
 * surface node is a safe START / END for a collapsed region (compaction): a
 * region must contain whole steps, never split an `assistant/message`'s
 * tool-calls from their `tool/result`s. Nodes belonging to no step (pre-step
 * user message, inter-step steering, injection context) are free boundaries.
 *
 * Builders mirror the agent loop's real append order so the fixtures are
 * representative: queued user messages land BEFORE `step/start`; within a step
 * the order is `assistant/message` then `tool/result`(s); injection turns are a
 * bare `turn/start → context/message → turn/end` with no step.
 */

const SURFACE = { surfaceOp: 'append' as const }

/** A closed turn with one closed step holding an assistant + its tool result. */
function toolStepLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, ...SURFACE },
    { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, content: [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' },
    ] }, ...SURFACE },
    { type: 'tool/call', seq: 4, time: 4, data: { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{}' } },
    { type: 'tool/result', seq: 5, time: 5, data: { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }, ...SURFACE },
    { type: 'step/end', seq: 6, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('isStepAlignedStart', () => {
  it('is true for a pre-step user/message (belongs to no step)', () => {
    // seq 1 user/message sits before step/start at seq 2 → free boundary.
    expect(isStepAlignedStart(toolStepLog(), 1)).toBe(true)
  })

  it('is true for the first surface node of a step (the assistant/message)', () => {
    // Backward from seq 3 the first significant event is step/start → aligned.
    expect(isStepAlignedStart(toolStepLog(), 3)).toBe(true)
  })

  it('is false for a tool/result whose assistant/message precedes it in the same step', () => {
    // Backward from seq 5 the first significant event is the assistant/message
    // surface node (seq 3) → starting here would orphan that assistant's call.
    expect(isStepAlignedStart(toolStepLog(), 5)).toBe(false)
  })

  it('is true at start-of-log (nothing precedes)', () => {
    const log: SessionEvent[] = [
      { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, ...SURFACE },
    ]
    expect(isStepAlignedStart(log, 0)).toBe(true)
  })

  it('skips noise (assistant/chunk, compact/* records) when scanning back', () => {
    // A compacted region landed compact/* log-only records between the prior
    // step boundary and this surface node; they must be skipped, not treated as
    // walls. Backward from seq 4 skips compact/end, compact/summary, compact/start
    // and stops at step/start (seq 0) → aligned.
    const log: SessionEvent[] = [
      { type: 'step/start', seq: 0, time: 0, data: { turn: 1, step: 1 } },
      { type: 'compact/start', seq: 1, time: 1, data: { turn: 1 } } as unknown as SessionEvent,
      { type: 'compact/summary', seq: 2, time: 2, data: { summary: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [], shadowedTokenCount: 0 } } as unknown as SessionEvent,
      { type: 'compact/end', seq: 3, time: 3, data: { turn: 1 } } as unknown as SessionEvent,
      { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }] }, ...SURFACE },
    ]
    expect(isStepAlignedStart(log, 4)).toBe(true)
  })
})

describe('isStepAlignedEnd', () => {
  it('is true for the last surface node of a closed step (the tool/result)', () => {
    // Forward from seq 5 the first significant event is step/end → aligned.
    expect(isStepAlignedEnd(toolStepLog(), 5)).toBe(true)
  })

  it('is false for an assistant/message with a later tool/result in the same step', () => {
    // Forward from seq 3 the first significant event is the tool/result surface
    // node (seq 5) → ending here would strand that result.
    expect(isStepAlignedEnd(toolStepLog(), 3)).toBe(false)
  })

  it('is true for a pre-step user/message (next significant event is step/start)', () => {
    expect(isStepAlignedEnd(toolStepLog(), 1)).toBe(true)
  })

  it('is false at EOL when the node is inside an open (unclosed) step', () => {
    // step/start then an assistant tool-call, but no step/end / tool/result yet
    // (mid-flight). Ending the region on seq 3 would summarize away a tool-call
    // whose result lands later → orphan. EOL + open step ⇒ not aligned.
    const log: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, content: [
        { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' },
      ] }, ...SURFACE },
    ]
    expect(isStepAlignedEnd(log, 2)).toBe(false)
  })

  it('is false at EOL when the node is inside an open step, skipping noise on the back-scan', () => {
    // The open-step back-scan must skip non-boundary events (here an
    // assistant/chunk) before it reaches step/start. Without the skip it would
    // mis-read the chunk as the nearest "boundary" and never confirm the open step.
    const log: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 2, time: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } } },
      { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, content: [
        { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' },
      ] }, ...SURFACE },
    ]
    expect(isStepAlignedEnd(log, 3)).toBe(false)
  })

  it('is true at EOL when the node is a trailing inter-step node (step already closed)', () => {
    // A steering message appended after step/end, at the tail. Backward the
    // nearest boundary is step/end → not in an open step → aligned.
    const log: SessionEvent[] = [
      { type: 'step/start', seq: 0, time: 0, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }] }, ...SURFACE },
      { type: 'step/end', seq: 2, time: 2, data: { turn: 1, step: 1 } },
      { type: 'steering/message', seq: 3, time: 3, data: { turn: 1, content: [{ type: 'text', text: 's' }], source: { kind: 'user' } }, ...SURFACE },
    ]
    expect(isStepAlignedEnd(log, 3)).toBe(true)
  })

  it('is true at EOL when no step ever opened (start-of-log fallback in open-step check)', () => {
    // A lone surface node, no turn/step markers at all → not in an open step.
    const log: SessionEvent[] = [
      { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, ...SURFACE },
    ]
    expect(isStepAlignedEnd(log, 0)).toBe(true)
  })

  it('skips noise (assistant/chunk) when scanning forward', () => {
    // assistant/chunk events precede the assistant/message in a real step; the
    // forward scan from an inter-step node must skip them and stop on step/start.
    const log: SessionEvent[] = [
      { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, ...SURFACE },
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 2, time: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } } },
    ]
    // Forward from seq 0 hits step/start at seq 1 → aligned (noise after is moot).
    expect(isStepAlignedEnd(log, 0)).toBe(true)
  })
})

describe('step-alignment on an injection turn (no step)', () => {
  // An idle inject() wraps a context/message in a bare turn/start → context/message
  // → turn/end with NO step/start. The context node is a free boundary both ways.
  const injectionLog = (): SessionEvent[] => [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'injection', source: { kind: 'user' } } } },
    { type: 'context/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'user' } }, ...SURFACE },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  it('start: aligned (backward hits turn/start)', () => {
    expect(isStepAlignedStart(injectionLog(), 1)).toBe(true)
  })

  it('end: aligned (forward hits turn/end)', () => {
    expect(isStepAlignedEnd(injectionLog(), 1)).toBe(true)
  })
})
