import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, isToolPairingBalanced } from '../src/index.ts'
import type { SessionEvent, SurfaceNode } from '../src/index.ts'

/**
 * Unit coverage for the tool-pairing balance check. It decides whether a CUT in
 * the surface (a gap before a given surface node, or the after-tail gap) is a
 * safe edge for a collapsed region (compaction): a region must never split an
 * `assistant/message`'s tool-calls from their `tool/result`s. A cut is balanced
 * when no unanswered tool-call sits before it on the surface. Nodes belonging to
 * no step (pre-step user message, inter-step steering, injection context) are
 * pairing-neutral, so their cuts are free boundaries.
 *
 * The fixtures are built through a real {@link Session} so the surface linked
 * list is derived exactly as production does — including the non-monotonic
 * surface a `replace` op leaves (a compaction checkpoint at a high log seq
 * sitting at the surface head), which is the case the abandoned log-position
 * scan mis-classified.
 *
 * Builders mirror the agent loop's real append order: queued user messages land
 * BEFORE `step/start`; within a step the order is `assistant/message` then
 * `tool/result`(s); injection turns are a bare `turn/start → context/message →
 * turn/end` with no step.
 */

const SURFACE = { surfaceOp: 'append' as const }

/** Surface nodes + log for a session, the two args the balance check takes. */
function surfaceOf(session: Session): { nodes: readonly SurfaceNode[]; events: readonly SessionEvent[] } {
  return { nodes: session.surface.nodes, events: session.events }
}

/** The cut BEFORE the surface node at `seq` is balanced (safe region start). */
function startBalanced(session: Session, seq: number): boolean {
  const { nodes, events } = surfaceOf(session)
  return isToolPairingBalanced(nodes, events, seq)
}

/** The cut AFTER the surface node at `seq` is balanced (safe region end). */
function endBalanced(session: Session, seq: number): boolean {
  const { nodes, events } = surfaceOf(session)
  const node = nodes.find(n => n.seq === seq)
  if (!node) throw new Error(`seq ${seq} is not a surface node`)
  return isToolPairingBalanced(nodes, events, node.next)
}

/** Surface seq of the nth (0-based) event of a given type. */
function seqOf(s: Session, type: SessionEvent['type'], nth = 0): number {
  return s.events.filter(e => e.type === type)[nth]!.seq
}

/** A closed turn with one closed step holding an assistant + its tool result. */
function toolStepSession(): Session {
  const s = new Session(SessionId('tool-step'))
  s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  s.append('user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, SURFACE)
  s.append('step/start', { turn: 1, step: 1 })
  s.append('assistant/message', {
    turn: 1, step: 1,
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' },
    ],
  }, SURFACE)
  s.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{}' })
  s.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }, SURFACE)
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return s
}

describe('isToolPairingBalanced — region START (cut before a node)', () => {
  it('is true for a pre-step user/message (belongs to no step)', () => {
    const s = toolStepSession()
    expect(startBalanced(s, seqOf(s, 'user/message'))).toBe(true)
  })

  it('is true for the first surface node of a step (the assistant/message)', () => {
    // The cut before the assistant is balanced — nothing unanswered precedes it.
    const s = toolStepSession()
    expect(startBalanced(s, seqOf(s, 'assistant/message'))).toBe(true)
  })

  it('is false for a tool/result whose assistant/message precedes it in the same step', () => {
    // The cut before the tool/result has one unanswered tool-call (the
    // assistant's) → starting the region here would orphan that call.
    const s = toolStepSession()
    expect(startBalanced(s, seqOf(s, 'tool/result'))).toBe(false)
  })

  it('is true at the surface head (nothing precedes)', () => {
    const s = new Session(SessionId('lone'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, SURFACE)
    expect(startBalanced(s, seqOf(s, 'user/message'))).toBe(true)
  })
})

describe('isToolPairingBalanced — region END (cut after a node)', () => {
  it('is true for the last surface node of a closed step (the tool/result)', () => {
    // After the tool/result the assistant's single call is answered → balanced.
    const s = toolStepSession()
    expect(endBalanced(s, seqOf(s, 'tool/result'))).toBe(true)
  })

  it('is false for an assistant/message with a later tool/result in the same step', () => {
    // After the assistant its tool-call is still unanswered → ending here strands
    // the result.
    const s = toolStepSession()
    expect(endBalanced(s, seqOf(s, 'assistant/message'))).toBe(false)
  })

  it('is true for a pre-step user/message', () => {
    const s = toolStepSession()
    expect(endBalanced(s, seqOf(s, 'user/message'))).toBe(true)
  })

  it('is false at the tail when the node is inside an open (unclosed) step', () => {
    // step/start then an assistant tool-call, but no tool/result yet (mid-flight).
    // The after-tail cut still has one unanswered call → not balanced.
    const s = new Session(SessionId('open-step'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [{ type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' }],
    }, SURFACE)
    expect(endBalanced(s, seqOf(s, 'assistant/message'))).toBe(false)
  })

  it('is true at the tail when the node is a trailing inter-step node (step already closed)', () => {
    // A steering message appended after step/end, at the tail. The prior step's
    // pair is balanced and steering is neutral → the after-tail cut is balanced.
    const s = new Session(SessionId('trailing-steer'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }] }, SURFACE)
    s.append('step/end', { turn: 1, step: 1 })
    s.append('steering/message', { turn: 1, content: [{ type: 'text', text: 's' }], source: { kind: 'user' } }, SURFACE)
    expect(endBalanced(s, seqOf(s, 'steering/message'))).toBe(true)
  })

  it('is true at the tail when no step ever opened', () => {
    const s = new Session(SessionId('no-step'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, SURFACE)
    expect(endBalanced(s, seqOf(s, 'user/message'))).toBe(true)
  })
})

describe('isToolPairingBalanced — multiple tool calls in one assistant message', () => {
  // An assistant message with two tool-calls needs BOTH results before the cut
  // after it is balanced — depth +2, then -1, -1.
  function twoCallStep(): Session {
    const s = new Session(SessionId('two-call'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [
        { type: 'tool-call', id: CallId('c1'), name: 'a', arguments: '{}' },
        { type: 'tool-call', id: CallId('c2'), name: 'b', arguments: '{}' },
      ],
    }, SURFACE)
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: '1' }], isError: false }, SURFACE)
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('c2'), content: [{ type: 'text', text: '2' }], isError: false }, SURFACE)
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return s
  }

  it('is unbalanced after the first of two results (one call still open)', () => {
    const s = twoCallStep()
    expect(endBalanced(s, seqOf(s, 'tool/result', 0))).toBe(false)
  })

  it('is balanced after the second result (both calls answered)', () => {
    const s = twoCallStep()
    expect(endBalanced(s, seqOf(s, 'tool/result', 1))).toBe(true)
  })
})

describe('isToolPairingBalanced — a mid-step injection context/message', () => {
  // A background task-done inject() lands a context/message INSIDE an open step,
  // between the assistant (with a tool-call) and its tool/result. It is
  // pairing-neutral, so the cut on EITHER side of it is unbalanced (the call is
  // still open across it) — it is NOT a free boundary in this position.
  function midStepInjection(): Session {
    const s = new Session(SessionId('mid-inject'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [{ type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' }],
    }, SURFACE)
    s.append('context/message', { content: [{ type: 'text', text: 'bg task done' }], source: { kind: 'plugin', plugin: 'tool-bash' } }, SURFACE)
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }, SURFACE)
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return s
  }

  it('start cut before the mid-step context/message is unbalanced (call still open)', () => {
    const s = midStepInjection()
    expect(startBalanced(s, seqOf(s, 'context/message'))).toBe(false)
  })

  it('end cut after the mid-step context/message is unbalanced (call still open)', () => {
    const s = midStepInjection()
    expect(endBalanced(s, seqOf(s, 'context/message'))).toBe(false)
  })
})

describe('isToolPairingBalanced on an injection turn (no step)', () => {
  // An idle inject() wraps a context/message in a bare turn/start →
  // context/message → turn/end with NO step. The context node is a free boundary
  // both ways (pairing-neutral, nothing open around it).
  function injectionSession(): Session {
    const s = new Session(SessionId('injection'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'injection', source: { kind: 'user' } } })
    s.append('context/message', { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'user' } }, SURFACE)
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return s
  }

  it('start: balanced', () => {
    const s = injectionSession()
    expect(startBalanced(s, seqOf(s, 'context/message'))).toBe(true)
  })

  it('end: balanced', () => {
    const s = injectionSession()
    expect(endBalanced(s, seqOf(s, 'context/message'))).toBe(true)
  })
})

describe('isToolPairingBalanced — CBR-001: a head checkpoint left by a replace op', () => {
  // The case the log-position scan got wrong. After a compaction, a replacement
  // user/message lands at a HIGH log seq but sits at the SURFACE head, beside
  // the still-open step whose events follow it in the log. It carries no
  // tool-call/result pair (just summarized prose), so it must be a balanced cut
  // on BOTH sides regardless of its log neighbours.
  function checkpointHeadedSession(): Session {
    const s = new Session(SessionId('checkpoint'))
    // A closed turn with a tool step → surface [u1, asst(call), result].
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { content: [{ type: 'text', text: 'u1' }], source: { kind: 'user' } }, SURFACE)
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [{ type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' }],
    }, SURFACE)
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }, SURFACE)
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // An OPEN turn whose step is in progress (loop fires compaction here).
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 2, step: 1 })
    // Compaction replaces the whole turn-1 surface ([u1, asst, result]) with one
    // summary user/message — appended now, so it carries a high log seq.
    const u1 = seqOf(s, 'user/message')
    const result = s.events.find(e => e.type === 'tool/result')!.seq
    s.append('user/message', {
      content: [{ type: 'text', text: 'CHECKPOINT' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }, { surfaceOp: { op: 'replace', start: u1, end: result } })
    // The step's own assistant/message lands AFTER the checkpoint in the log,
    // still inside the open step.
    s.append('assistant/message', { turn: 2, step: 1, content: [{ type: 'text', text: 'a2' }] }, SURFACE)
    return s
  }

  it('the head checkpoint sits at the surface head while a later surface node follows it in the log', () => {
    const s = checkpointHeadedSession()
    const nodes = s.surface.nodes
    const checkpointSeq = nodes[0]!.seq
    // The checkpoint heads the surface, yet a surface node (the open step's
    // assistant) follows it in LOG order — the exact split between surface
    // position and log position that the log-position scan tripped on.
    const laterSurfaceInLog = s.events.find(
      e => e.seq > checkpointSeq && nodes.some(n => n.seq === e.seq),
    )
    expect(laterSurfaceInLog).toBeDefined()
    expect(nodes[0]!.seq).toBe(checkpointSeq)
  })

  it('start cut before the head checkpoint is balanced (it is the head)', () => {
    const s = checkpointHeadedSession()
    expect(startBalanced(s, s.surface.nodes[0]!.seq)).toBe(true)
  })

  it('end cut after the head checkpoint is balanced (it carries no tool pair)', () => {
    // This is the exact assertion the log-position scan failed: the forward log
    // scan from the checkpoint reached the open step's assistant/message and
    // wrongly reported mid-step. The surface balance sees a neutral node whose
    // following cut closes no open call.
    const s = checkpointHeadedSession()
    expect(endBalanced(s, s.surface.nodes[0]!.seq)).toBe(true)
  })
})

describe('isToolPairingBalanced — corrupt surface guard', () => {
  it('throws when a tool/result has no preceding tool-call (depth goes negative)', () => {
    // A surface that opens with a tool/result (no assistant call before it) is
    // structurally corrupt — surfaced loudly rather than mis-classified.
    const s = new Session(SessionId('corrupt'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'x' }], isError: false }, SURFACE)
    const { nodes, events } = surfaceOf(s)
    expect(() => isToolPairingBalanced(nodes, events, null)).toThrow(/no matching tool-call/)
  })
})
