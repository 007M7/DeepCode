import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { BasicCompactService } from '@deepseek-ai/dsh-compact-basic'
import type { BasicCompactConfig } from '@deepseek-ai/dsh-compact-basic'
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter, LlmService } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceEvent } from '@deepseek-ai/dsh-session'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** A never-aborted signal for the required `compactIfNeeded`/listener arg. */
const SIGNAL = new AbortController().signal

/**
 * A BasicCompactService with summarize() stubbed (no real model call) and a
 * predictable token estimate, for deterministic unit tests of the algorithm.
 */
class TestCompactService extends BasicCompactService {
  /** Track calls to summarize for test assertions. */
  summarizeCalls: { text: string; model: string }[] = []
  /** The fixed summary to return. */
  mockSummary: ContentBlock[] = [{ type: 'text', text: 'Test summary of compacted content.' }]
  /** If set, summarize() throws this error. */
  summarizeError: Error | null = null

  override estimateContentTokens(blocks: readonly ContentBlock[]): number {
    // 10 tokens per block — predictable for retention/threshold math.
    return blocks.length * 10
  }

  override async summarize(text: string, model: string): Promise<ContentBlock[]> {
    this.summarizeCalls.push({ text, model })
    if (this.summarizeError) throw this.summarizeError
    return this.mockSummary
  }
}

/**
 * Create a test service with a throwaway context (auto disabled — no model).
 * A small `summarizationMaxTokens` baseline keeps the convergence invariant
 * (`summarizationMaxTokens + retainTokens <= contextWindow * thresholdRatio`)
 * satisfied for the tiny windows these tests use; a test may override it.
 */
function createTestService(config: BasicCompactConfig = {}): TestCompactService {
  return new TestCompactService(new Context(), { auto: false, summarizationMaxTokens: 1, ...config })
}

/**
 * Build a multi-turn session with surface markers (simulating real agent-loop
 * output). Compaction always runs inside an OPEN turn (the loop fires the
 * `agent/pre-step` seam after a turn's start and before a step's start), so by
 * default the session is left with a trailing open turn: turns `1..turns`
 * close, then one more `turn/start` opens with no matching `turn/end`. Pass
 * `{ leaveOpen: false }` for a fully-closed session (e.g. to assert that manual
 * compaction is rejected when no turn is open).
 */
function multiTurnSession(turns: number, messagesPerTurn: number = 2, opts: { leaveOpen?: boolean } = {}): Session {
  const leaveOpen = opts.leaveOpen ?? true
  const s = new Session(SessionId('test'))
  for (let t = 1; t <= turns; t++) {
    s.append('turn/start', { turn: t, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: t, step: 1 })
    for (let m = 0; m < messagesPerTurn; m++) {
      s.append('user/message', {
        content: [{ type: 'text', text: `turn ${t} user message ${m + 1}` }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
      s.append('assistant/message', {
        turn: t, step: 1,
        content: [{ type: 'text', text: `turn ${t} assistant response ${m + 1}` }],
      }, { surfaceOp: 'append' })
    }
    s.append('step/end', { turn: t, step: 1 })
    s.append('turn/end', { turn: t, reason: { kind: 'completed' } })
  }
  // Open one more turn so compaction's events are turn-enclosed, as they are
  // when the loop runs the auto-compaction listener mid-turn.
  if (leaveOpen) {
    s.append('turn/start', { turn: turns + 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  }
  return s
}

/** Build a session with tool calls for richer extraction tests. */
function sessionWithTools(): Session {
  const s = new Session(SessionId('tools'))
  s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('user/message', {
    content: [{ type: 'text', text: 'read file x' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  s.append('assistant/message', {
    turn: 1, step: 1,
    content: [
      { type: 'text', text: 'Let me read that file.' },
      { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{"command":"cat x"}' },
    ],
  }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{"command":"cat x"}' })
  s.append('tool/result', {
    turn: 1, step: 1, callId: CallId('c1'),
    content: [{ type: 'text', text: 'hello world' }],
    isError: false,
  }, { surfaceOp: 'append' })
  s.append('assistant/message', {
    turn: 1, step: 1,
    content: [{ type: 'text', text: 'The file contains: hello world' }],
  }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Open a trailing turn so compaction's events are turn-enclosed (as they are
  // when the loop runs the auto-compaction listener mid-turn).
  s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
  return s
}

/**
 * Build a session of `turns` turns, each a SINGLE step containing an
 * assistant/message that issues a tool-call plus its tool/result — the real
 * multi-node-step shape (a step is two surface nodes: the assistant and the
 * result). Each turn is preceded by a user/message. Used to exercise
 * step-alignment: a region boundary must not fall between the assistant and its
 * result.
 */
function toolTurnSession(turns: number): Session {
  const s = new Session(SessionId('tools-multi'))
  for (let t = 1; t <= turns; t++) {
    s.append('turn/start', { turn: t, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('user/message', {
      content: [{ type: 'text', text: `turn ${t} request` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    s.append('step/start', { turn: t, step: 1 })
    s.append('assistant/message', {
      turn: t, step: 1,
      content: [
        { type: 'text', text: `turn ${t} calling tool` },
        { type: 'tool-call', id: CallId(`c${t}`), name: 'bash', arguments: '{"command":"ls"}' },
      ],
    }, { surfaceOp: 'append' })
    s.append('tool/call', { turn: t, step: 1, callId: CallId(`c${t}`), name: 'bash', arguments: '{"command":"ls"}' })
    s.append('tool/result', {
      turn: t, step: 1, callId: CallId(`c${t}`),
      content: [{ type: 'text', text: `turn ${t} output` }],
      isError: false,
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn: t, step: 1 })
    s.append('turn/end', { turn: t, reason: { kind: 'completed' } })
  }
  // Open a trailing turn so compaction's events are turn-enclosed.
  s.append('turn/start', { turn: turns + 1, trigger: { kind: 'message', source: { kind: 'user' } } })
  return s
}

/**
 * Assert the derived transcript has NO orphaned tool-result: every
 * `tool-result` block's `toolCallId` must be matched by a preceding `tool-call`
 * block in an earlier (assistant) message. A dangling tool-result is exactly
 * what splitting a step at compaction produces, and every provider rejects it.
 */
function expectNoOrphanToolResults(messages: Message[]): void {
  const seenCallIds = new Set<string>()
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool-call') seenCallIds.add(block.id)
      if (block.type === 'tool-result') {
        expect(seenCallIds.has(block.toolCallId),
          `orphaned tool-result for callId ${block.toolCallId} (no preceding tool-call)`).toBe(true)
      }
    }
  }
}

describe('BasicCompactService step-alignment (never split a tool-call/result pair)', () => {
  it('compactIfNeeded rounds the retained boundary head-ward to keep a whole step (no orphaned tool-result)', async () => {
    // 3 turns, each one step = { assistant(tool-call), tool/result }. Surface
    // (9 nodes): user1, asst1, res1, user2, asst2, res2, user3, asst3, res3 —
    // 10/20/10 tokens. The tail→head walk retains by whole units; the compacted
    // region always ends on a step boundary, so no step's tool-call is split
    // from its result. retainTokens=55 keeps the recent tail; the older steps
    // compact intact.
    const svc = createTestService({ contextWindow: 200, thresholdRatio: 0.5, retainTokens: 55 })
    const session = toolTurnSession(3)

    const result = await svc.compactIfNeeded(session, '', 'm', SIGNAL)
    expect(result).not.toBeNull()
    expect(result!.shadowedSeqs.length).toBeGreaterThan(0)
    // No dangling tool-result: every compacted/retained step stayed whole.
    expectNoOrphanToolResults(session.deriveMessages())
    // The most-recent step's result is retained verbatim (still on the surface).
    const lastResultSeq = session.events.findLast(e => e.type === 'tool/result')!.seq
    expect(result!.shadowedSeqs).not.toContain(lastResultSeq)
  })

  it('compactIfNeeded returns null when the only compactable region is an un-splittable single step', async () => {
    // The surface is exactly ONE step: [assistant(tool-call), tool/result]. Over
    // threshold (by the derived role overhead), the tail→head walk stops with the
    // retained boundary at the tool/result — which is NOT a step-aligned start (its
    // issuing assistant precedes it in the same step). Rounding head-ward to find a
    // clean boundary reaches index 0, so there is no step-aligned cutoff in the
    // compactable range: compactIfNeeded declines rather than splitting the step.
    const s = new Session(SessionId('one-step'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [{ type: 'text', text: 'calling' }, { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    s.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{}' })
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'out' }], isError: false }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    // Turn stays open.

    const svc = createTestService({ contextWindow: 100, thresholdRatio: 0.1, retainTokens: 5 })
    const result = await svc.compactIfNeeded(s, '', 'm', SIGNAL)
    expect(result).toBeNull()
    expect(s.events.some(e => e.type === 'compact/start')).toBe(false)
  })

  it('compactRegion rejects a start that splits a step (unbalanced boundary)', async () => {
    const svc = createTestService()
    const session = toolTurnSession(1)
    const nodes = session.surface.nodes // [user, asst(tool-call), result]
    const userSeq = nodes[0]!.seq
    const resultSeq = nodes[2]!.seq
    // start = the tool/result: its issuing assistant precedes it IN THE SAME STEP,
    // so starting here would orphan that assistant's tool-call. end is fine (user).
    await expect(svc.compactRegion(session, resultSeq, resultSeq, 'm'))
      .rejects.toThrow(/start seq .* is not a balanced boundary/)
    expect(userSeq).toBeLessThan(resultSeq) // sanity: ordering as expected
  })

  it('compactRegion rejects an end that splits a step (unbalanced boundary)', async () => {
    const svc = createTestService()
    const session = toolTurnSession(1)
    const nodes = session.surface.nodes
    const userSeq = nodes[0]!.seq
    const asstSeq = nodes[1]!.seq
    // end = the assistant/message: its tool/result follows IN THE SAME STEP, so
    // ending here would strand that result. start is fine (the pre-step user).
    await expect(svc.compactRegion(session, userSeq, asstSeq, 'm'))
      .rejects.toThrow(/end seq .* is not a balanced boundary/)
  })

  it('compactRegion rejects an end inside an open tail step', async () => {
    const svc = createTestService()
    const s = new Session(SessionId('open-tail'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [{ type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    const nodes = s.surface.nodes // [user, asst]
    const userSeq = nodes[0]!.seq
    const asstSeq = nodes[1]!.seq
    await expect(svc.compactRegion(s, userSeq, asstSeq, 'm'))
      .rejects.toThrow(/end seq .* is not a balanced boundary/)
  })

  it('compactRegion accepts step-aligned boundaries (pre-step user → last result of a closed step)', async () => {
    const svc = createTestService()
    const session = toolTurnSession(2)
    const nodes = session.surface.nodes // [user1, asst1, res1, user2, asst2, res2]
    const startSeq = nodes[0]!.seq // pre-step user1 (free boundary)
    const endSeq = nodes[2]!.seq   // res1 = last node of turn 1's closed step
    const result = await svc.compactRegion(session, startSeq, endSeq, 'm')
    expect(result.shadowedRange).toEqual({ start: startSeq, end: endSeq })
    expectNoOrphanToolResults(session.deriveMessages())
  })

  it('compactRegion accepts a single inter-step node (start === end on a pre-step user/message)', async () => {
    const svc = createTestService()
    const session = toolTurnSession(1)
    const nodes = session.surface.nodes
    const userSeq = nodes[0]!.seq // pre-step user: free boundary both ways
    const result = await svc.compactRegion(session, userSeq, userSeq, 'm')
    expect(result.shadowedRange).toEqual({ start: userSeq, end: userSeq })
  })

  it('compactRegion accepts an injection-turn context node (no step at all)', async () => {
    const svc = createTestService()
    const s = new Session(SessionId('inject'))
    // An idle inject(): turn/start → context/message, NO step. A later turn is
    // open so compaction's events are turn-enclosed.
    s.append('turn/start', { turn: 1, trigger: { kind: 'injection', source: { kind: 'user' } } })
    s.append('context/message', { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    const nodes = s.surface.nodes
    const ctxSeq = nodes[0]!.seq
    const result = await svc.compactRegion(s, ctxSeq, ctxSeq, 'm')
    expect(result.shadowedRange).toEqual({ start: ctxSeq, end: ctxSeq })
  })
})

describe('BasicCompactService.estimateEventTokens', () => {
  it('returns 0 for non-message events (boundary, chunk, step/end, tool/call)', () => {
    const svc = createTestService()
    expect(svc.estimateEventTokens({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } })).toBe(0)
    expect(svc.estimateEventTokens({ type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } })).toBe(0)
    expect(svc.estimateEventTokens({ type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'h' } } })).toBe(0)
    expect(svc.estimateEventTokens({ type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } })).toBe(0)
    expect(svc.estimateEventTokens({ type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, callId: CallId('c1'), name: 'read', arguments: '{}' } })).toBe(0)
  })

  it('returns estimate for message-producing events', () => {
    const svc = createTestService()
    const userEvent: SessionEvent = { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } }
    expect(svc.estimateEventTokens(userEvent)).toBe(10)

    const asstEvent: SessionEvent = { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }
    expect(svc.estimateEventTokens(asstEvent)).toBe(20)

    const toolEvent: SessionEvent = { type: 'tool/result', seq: 2, time: 3, data: { turn: 1, step: 1, callId: CallId('c1'), content: [{ type: 'text', text: 'output' }], isError: false } }
    expect(svc.estimateEventTokens(toolEvent)).toBe(10)
  })
})

describe('BasicCompactService.estimateTokens', () => {
  it('sums token estimates across messages', () => {
    const svc = createTestService()
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'there' }] },
    ]
    // 1 block * 10 + 4 (role) + 2 blocks * 10 + 4 (role) = 10 + 4 + 20 + 4 = 38
    expect(svc.estimateTokens(messages)).toBe(38)
  })

  it('includes system prompt in the estimate', () => {
    const svc = createTestService()
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]
    const systemPrompt = 'You are a helpful assistant.'
    // 1 block * 10 + 4 (role) + ceil(28/4) = 10 + 4 + 7 = 21
    expect(svc.estimateTokens(messages, systemPrompt)).toBe(21)
  })
})

describe('BasicCompactService.compactRegion', () => {
  it('shadows surface nodes and inserts a summary via user/message', async () => {
    const svc = createTestService()
    const session = multiTurnSession(3, 1) // 3 turns, 2 surface nodes each = 6 nodes

    const nodes = session.surface.nodes
    expect(nodes.length).toBe(6)

    const firstSeq = nodes[0]!.seq
    const secondSeq = nodes[1]!.seq
    const result = await svc.compactRegion(session, firstSeq, secondSeq, 'test-model')

    expect(result.shadowedSeqs).toEqual([firstSeq, secondSeq])
    expect(result.shadowedRange.start).toBe(firstSeq)
    expect(result.shadowedRange.end).toBe(secondSeq)
    expect(result.summary).toEqual(svc.mockSummary)

    const events = session.events
    const startEvent = events.findLast(e => e.type === 'compact/start')
    const summaryEvent = events.findLast(e => e.type === 'compact/summary')
    const endEvent = events.findLast(e => e.type === 'compact/end')
    expect(startEvent).toBeDefined()
    expect(summaryEvent).toBeDefined()
    expect(endEvent).toBeDefined()

    // compact/* events are log-only — no surfaceOp (type system enforces this).
    const startRaw = startEvent as unknown as { surfaceOp?: unknown }
    expect(startRaw.surfaceOp).toBeUndefined()

    // The user/message carries the replace surfaceOp.
    const userMsg = events.findLast(e => e.type === 'user/message')!
    const surfaceUserMsg = userMsg as SurfaceEvent
    expect(surfaceUserMsg.surfaceOp).toEqual({ op: 'replace', start: firstSeq, end: secondSeq })
    expect(surfaceUserMsg.sourceEventSeqs).toContain(startEvent!.seq)
    expect(surfaceUserMsg.sourceEventSeqs).toContain(summaryEvent!.seq)
    expect(surfaceUserMsg.sourceEventSeqs).toContain(firstSeq)
    expect(surfaceUserMsg.sourceEventSeqs).toContain(secondSeq)
    // compact/end is appended AFTER the replacement (the lock brackets the whole
    // op), so the replacement cannot reference it — sourceEventSeqs may only
    // reference earlier seqs.
    expect(surfaceUserMsg.sourceEventSeqs).not.toContain(endEvent!.seq)
    expect(endEvent!.seq).toBeGreaterThan(userMsg.seq)

    // Surface now has: summary user/message + retained 4 nodes = 5 nodes.
    const newNodes = session.surface.nodes
    expect(newNodes.length).toBe(5)
    expect(newNodes[0]!.seq).toBe(userMsg.seq)

    // deriveMessages() produces the framed summary as a user-role message:
    // a checkpoint preamble + tag-wrapped summary blocks.
    const derived = session.deriveMessages()
    expect(derived.length).toBe(5)
    expect(derived[0]!.role).toBe('user')
    const framed = derived[0]!.content
    expect(framed[0]).toMatchObject({ type: 'text' })
    expect((framed[0] as { text: string }).text).toContain('<compacted-summary>')
    expect(framed).toContainEqual(svc.mockSummary[0])
    expect((framed[framed.length - 1] as { text: string }).text).toBe('</compacted-summary>')
  })

  it('throws when start or end are not surface nodes', async () => {
    const svc = createTestService()
    const session = multiTurnSession(1, 1)
    await expect(svc.compactRegion(session, 999, 1000, 'm'))
      .rejects.toThrow(/start seq 999 not found in surface/)
  })

  it('throws when start is positioned after end on the surface', async () => {
    const svc = createTestService()
    const session = multiTurnSession(2, 1)
    const nodes = session.surface.nodes
    await expect(svc.compactRegion(session, nodes[1]!.seq, nodes[0]!.seq, 'm'))
      .rejects.toThrow(/is after end seq .* on the surface/)
  })

  it('throws when compaction is already in progress', async () => {
    const svc = createTestService()
    const session = multiTurnSession(2, 1)
    const nodes = session.surface.nodes
    session.append('compact/start', { turn: 2 })
    await expect(svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'm'))
      .rejects.toThrow(/compaction already in progress/)
  })

  it('appends compact/end with error on summarize failure', async () => {
    const svc = createTestService()
    svc.summarizeError = new Error('model unavailable')
    const session = multiTurnSession(2, 1)
    const nodes = session.surface.nodes

    await expect(svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'm'))
      .rejects.toThrow('model unavailable')

    const endEvent = session.events.findLast(e => e.type === 'compact/end')
    expect(endEvent).toBeDefined()
    // multiTurnSession(2,…) closes turns 1-2 and leaves turn 3 open; compaction
    // stamps the open turn.
    expect(endEvent!.data).toMatchObject({ turn: 3, error: 'model unavailable' })

    // No replace-op user/message was appended (summarize failed).
    const userMsgsAfter = session.events.filter(e => e.type === 'user/message')
    const replaceMsgs = userMsgsAfter.filter((e) => {
      const se = e as unknown as { surfaceOp?: unknown }
      return se.surfaceOp !== undefined && typeof se.surfaceOp !== 'string'
    })
    expect(replaceMsgs.length).toBe(0)
  })

  it('extracts conversation text for summarization', async () => {
    const svc = createTestService()
    const session = multiTurnSession(1, 2)
    const nodes = session.surface.nodes

    await svc.compactRegion(session, nodes[0]!.seq, nodes[nodes.length - 1]!.seq, 'm')

    expect(svc.summarizeCalls.length).toBe(1)
    const { text, model } = svc.summarizeCalls[0]!
    expect(model).toBe('m')
    expect(text).toContain('User: turn 1 user message 1')
    expect(text).toContain('Assistant: turn 1 assistant response 1')
  })

  it('frames the landed summary with a checkpoint preamble and tags, keeping raw provenance', async () => {
    const svc = createTestService()
    svc.mockSummary = [{ type: 'text', text: 'STRUCTURED SUMMARY' }]
    const session = multiTurnSession(3, 1)
    const nodes = session.surface.nodes

    const result = await svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'm')

    // Provenance (compact/summary) carries the RAW, unframed summary.
    expect(result.summary).toEqual([{ type: 'text', text: 'STRUCTURED SUMMARY' }])
    const summaryEvent = session.events.findLast(e => e.type === 'compact/summary')!
    expect(summaryEvent.data).toMatchObject({ summary: [{ type: 'text', text: 'STRUCTURED SUMMARY' }] })

    // The landed surface node is framed: preamble + tag-wrapped summary.
    const landed = session.deriveMessages()[0]!.content
    expect((landed[0] as { text: string }).text).toContain('checkpoint')
    expect((landed[0] as { text: string }).text).toContain('<compacted-summary>')
    expect(landed).toContainEqual({ type: 'text', text: 'STRUCTURED SUMMARY' })
    expect((landed[landed.length - 1] as { text: string }).text).toBe('</compacted-summary>')
  })

  it('extracts tool-call and tool-result context', async () => {
    const svc = createTestService()
    const session = sessionWithTools()
    const nodes = session.surface.nodes

    const firstSeq = nodes[0]!.seq
    const lastSeq = nodes[nodes.length - 1]!.seq
    await svc.compactRegion(session, firstSeq, lastSeq, 'm')

    expect(svc.summarizeCalls.length).toBe(1)
    const { text } = svc.summarizeCalls[0]!
    expect(text).toContain('read file x')
    expect(text).toContain('bash')
    expect(text).toContain('Tool result')
  })
})

describe('BasicCompactService.compactIfNeeded', () => {
  it('returns null when tokens are under threshold', async () => {
    const svc = createTestService({ contextWindow: 128000, thresholdRatio: 0.8 })
    const session = multiTurnSession(1, 1)
    expect(await svc.compactIfNeeded(session, '', 'm', SIGNAL)).toBeNull()
  })

  it('compacts when tokens exceed threshold', async () => {
    const svc = createTestService({ contextWindow: 100, thresholdRatio: 0.5, retainTokens: 10 })
    const session = multiTurnSession(3, 1) // 6 surface nodes, 10 tokens each = 60

    const result = await svc.compactIfNeeded(session, '', 'm', SIGNAL)
    expect(result).not.toBeNull()
    expect(result!.shadowedSeqs.length).toBeGreaterThan(0)
  })

  it('walks tail→head and retains nodes within token budget', async () => {
    const svc = createTestService({ contextWindow: 100, thresholdRatio: 0.2, retainTokens: 15 })
    const session = multiTurnSession(5, 1) // 10 surface nodes = ~100 tokens

    const result = await svc.compactIfNeeded(session, '', 'm', SIGNAL)
    expect(result).not.toBeNull()
    const nodes = session.surface.nodes
    expect(result!.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result!.shadowedSeqs).not.toContain(nodes[nodes.length - 1]!.seq)
  })

  it('returns null when the whole surface fits the retain budget (over threshold by role/system overhead)', async () => {
    // threshold = floor(470*0.1) = 47. The 4 surface nodes weigh 10 each (raw 40
    // for the retention walk), but the derived estimate adds 4 role tokens per
    // message → 56 ≥ 47, so the threshold check passes and the walk runs. The
    // walk accumulates all 40 < retainTokens (45) without crossing the budget,
    // so keepFromIdx reaches 0 and compaction declines. The invariant holds:
    // summarizationMaxTokens (1) + retainTokens (45) = 46 < threshold 47.
    const svc = createTestService({ contextWindow: 470, thresholdRatio: 0.1, retainTokens: 45 })
    const session = multiTurnSession(2, 1)
    expect(await svc.compactIfNeeded(session, '', 'm', SIGNAL)).toBeNull()
  })

  it('compacts a runaway turn: its early CLOSED steps summarize while recent steps stay verbatim', async () => {
    // The REGRESSION that motivated dropping turn-protection. A single in-flight
    // (open) turn has grown past the threshold on its own: several CLOSED steps,
    // each [assistant(tool-call), tool/result]. Retention is turn-agnostic, so
    // the turn's OWN early closed steps are eligible — they compact while the
    // recent tail stays verbatim, and the harness survives.
    //
    // On the OLD layer-2 code this test FAILS: the entire open turn was retained
    // verbatim (protectedIdx = first open-turn node = 0), so compactIfNeeded
    // returned null and shadowedSeqs would be empty — the runaway turn could
    // never compact and the next model call would overflow the window.
    const svc = createTestService({ contextWindow: 300, thresholdRatio: 0.1, retainTokens: 25 })
    const s = new Session(SessionId('runaway'))
    // ONE open turn with 5 closed steps; each step is [asst(tool-call), result].
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('user/message', { content: [{ type: 'text', text: 'do a big multi-step task' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    for (let step = 1; step <= 5; step++) {
      s.append('step/start', { turn: 1, step })
      s.append('assistant/message', {
        turn: 1, step,
        content: [{ type: 'text', text: `step ${step}` }, { type: 'tool-call', id: CallId(`c${step}`), name: 'bash', arguments: '{}' }],
      }, { surfaceOp: 'append' })
      s.append('tool/call', { turn: 1, step, callId: CallId(`c${step}`), name: 'bash', arguments: '{}' })
      s.append('tool/result', { turn: 1, step, callId: CallId(`c${step}`), content: [{ type: 'text', text: `out ${step}` }], isError: false }, { surfaceOp: 'append' })
      s.append('step/end', { turn: 1, step })
    }
    // The turn stays OPEN (no turn/end) — the model is mid-turn, about to run
    // step 6. Surface: user + 5×[asst, result] = 11 nodes.
    const nodesBefore = s.surface.nodes.length
    expect(nodesBefore).toBe(11)

    const result = await svc.compactIfNeeded(s, '', 'm', SIGNAL)
    expect(result).not.toBeNull()
    // Early steps of the SAME open turn were shadowed (impossible under layer 2).
    expect(result!.shadowedSeqs.length).toBeGreaterThan(0)
    // The most-recent step's tool result is retained verbatim (still on surface).
    const lastResultSeq = s.events.findLast(e => e.type === 'tool/result')!.seq
    expect(result!.shadowedSeqs).not.toContain(lastResultSeq)
    expect(s.surface.nodes.some(n => n.seq === lastResultSeq)).toBe(true)
    // No orphaned tool-result survives (whole-step boundaries respected).
    expectNoOrphanToolResults(s.deriveMessages())
  })

  it('returns null for an empty surface', async () => {
    const svc = createTestService({ contextWindow: 100, thresholdRatio: 0.5, retainTokens: 10 })
    const session = new Session(SessionId('empty'))
    expect(await svc.compactIfNeeded(session, '', 'm', SIGNAL)).toBeNull()
  })

  it('compacts again after a prior summary node heads the surface (the summary stays eligible)', async () => {
    // After the first compaction lands a replacement summary node at the head,
    // a second compaction (still over threshold) re-consolidates it with newer
    // context — head-anchoring means the prior checkpoint is always re-included,
    // never stranded. retainTokens=25 leaves a couple of retained nodes after
    // the first compaction (so the surface is [summary, …retained], not just
    // [summary]).
    const svc = createTestService({ contextWindow: 300, thresholdRatio: 0.1, retainTokens: 25 })
    const s = multiTurnSession(4, 1) // turns 1-4 closed, turn 5 open (no surface yet)

    const first = await svc.compactIfNeeded(s, '', 'm', SIGNAL)
    expect(first).not.toBeNull()
    // The summary node now heads the surface with a fresh high seq.
    const summaryHeadSeq = s.surface.nodes[0]!.seq
    const turn5StartSeq = s.events.filter(e => e.type === 'turn/start').at(-1)!.seq
    expect(summaryHeadSeq).toBeGreaterThan(turn5StartSeq)

    // Append a verbatim node in the open turn (a step's output), still over
    // threshold, then compact again — the older summary + closed turns compact,
    // the fresh nodes are retained.
    s.append('step/start', { turn: 5, step: 1 })
    s.append('user/message', { content: [{ type: 'text', text: 'turn 5 work' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 5, step: 1, content: [{ type: 'text', text: 'reply 5' }] }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 5, step: 1 })

    const second = await svc.compactIfNeeded(s, '', 'm', SIGNAL)
    expect(second).not.toBeNull()
    expect(second!.shadowedSeqs.length).toBeGreaterThan(0)
    // The fresh open-turn nodes were NOT compacted.
    const turn5UserSeq = s.events.find(e => e.type === 'user/message' && e.data.content.some(b => b.type === 'text' && b.text === 'turn 5 work'))!.seq
    expect(second!.shadowedSeqs).not.toContain(turn5UserSeq)
  })
})

describe('BasicCompactService replay equivalence', () => {
  it('produces identical deriveMessages() after seeding from compacted log', async () => {
    const svc = createTestService()
    const session = multiTurnSession(3, 1)
    const nodes = session.surface.nodes

    await svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'm')
    const derived = session.deriveMessages()

    const replayed = new Session(SessionId('replay'), [...session.events])
    expect(replayed.deriveMessages()).toEqual(derived)
  })
})

describe('BasicCompactService blocking (compaction in progress)', () => {
  it('detects in-progress compaction from unmatched compact/start', async () => {
    const svc = createTestService()
    const session = multiTurnSession(1, 1)
    session.append('compact/start', { turn: 1 })
    const nodes = session.surface.nodes
    // Whole step (user → assistant) is a step-aligned region, so the call reaches
    // the in-progress check rather than being rejected for splitting a step.
    await expect(svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'm'))
      .rejects.toThrow(/compaction already in progress/)
  })

  it('allows compaction after compact/end is appended', async () => {
    const svc = createTestService()
    const session = multiTurnSession(2, 1)
    const nodes = session.surface.nodes
    session.append('compact/start', { turn: 1 })
    session.append('compact/end', { turn: 1 })
    const result = await svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'm')
    expect(result).toBeDefined()
  })

  it('is not wedged by an orphaned compact/start from a prior (now-closed) turn', async () => {
    // A crash mid-compaction left a compact/start with no compact/end; the turn
    // it lived in was later closed (persistence repair appends turn/end). A
    // whole-log scan would treat that stale start as an active lock forever. The
    // scan is scoped to the current turn, so a NEW turn compacts normally.
    const svc = createTestService()
    const s = new Session(SessionId('stale-lock'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { content: [{ type: 'text', text: 'turn 1' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'reply 1' }] }, { surfaceOp: 'append' })
    s.append('compact/start', { turn: 1 }) // ← orphaned: no matching compact/end
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } }) // repair closed the turn
    // A new open turn.
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })
    const nodes = s.surface.nodes

    // The stale start is before the turn/end, so it is NOT seen as in-progress.
    const result = await svc.compactRegion(s, nodes[0]!.seq, nodes[1]!.seq, 'm')
    expect(result).toBeDefined()
  })
})

describe('BasicCompactService token estimation (char/4 heuristic)', () => {
  it('estimates text blocks with char/4 + overhead', () => {
    const svc = new BasicCompactService(new Context(), { auto: false })
    // 'this is a somewhat longer text block' = 36 → ceil(36/4)+4 = 13; 'short' = 5 → 2+4 = 6
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'this is a somewhat longer text block' },
      { type: 'text', text: 'short' },
    ]
    expect(svc.estimateContentTokens(blocks)).toBe(19)
  })

  it('estimates reasoning blocks same as text', () => {
    const svc = new BasicCompactService(new Context(), { auto: false })
    // 'thinking about this...' = 22 → ceil(22/4)+4 = 10
    expect(svc.estimateContentTokens([{ type: 'reasoning', text: 'thinking about this...' }])).toBe(10)
  })

  it('estimates tool-call blocks from name + arguments', () => {
    const svc = new BasicCompactService(new Context(), { auto: false })
    // 'bash' = 4 → 1; '{"command":"ls"}' = 16 → 4; + 4 overhead = 9
    expect(svc.estimateContentTokens([
      { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' },
    ])).toBe(9)
  })

  it('estimates tool-result blocks recursively', () => {
    const svc = new BasicCompactService(new Context(), { auto: false })
    // inner text 5 → 2+4 = 6; outer 6 + 4 overhead = 10
    expect(svc.estimateContentTokens([
      { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'hello' }], isError: false },
    ])).toBe(10)
  })

  it('estimates image blocks at fixed 85 tokens', () => {
    const svc = new BasicCompactService(new Context(), { auto: false })
    expect(svc.estimateContentTokens([{ type: 'image', url: 'https://example.com/img.png' }])).toBe(85)
  })

  it('returns 0 for empty content blocks', () => {
    const svc = new BasicCompactService(new Context(), { auto: false })
    expect(svc.estimateContentTokens([])).toBe(0)
  })
})

describe('BasicCompactService HMR safety', () => {
  it('registers as ctx.compact', () => {
    const ctx = new Context()
    void new BasicCompactService(ctx, { auto: false })
    expect(ctx.compact).toBeDefined()
    expect(ctx.compact).toBeInstanceOf(BasicCompactService)
  })

  it('disposing the plugin fiber unregisters ctx.compact', async () => {
    // Mount through the real plugin fiber (the Loader path), then dispose it and
    // confirm the service registration is torn down. LlmService is mounted first
    // so the service's `inject: ['llm']` resolves and the fiber activates. (The
    // sibling-fiber ctx.llm resolution this same setup also exercises is covered
    // under the "llm inject (real plugin-load path)" suite.)
    const ctx = new Context()
    await ctx.plugin(LlmService)
    const fiber = await ctx.plugin(BasicCompactService, { auto: false })
    expect(ctx.get('compact')).toBeInstanceOf(BasicCompactService)

    await fiber.dispose()
    expect(ctx.get('compact')).toBeUndefined()
  })
})

describe('BasicCompactService convergence invariant (config)', () => {
  it('throws when summarizationMaxTokens + retainTokens exceeds the threshold', () => {
    // threshold = floor(1000 * 0.5) = 500; 200 + 400 = 600 is not below 500 → reject.
    expect(() => new BasicCompactService(new Context(), {
      auto: false, contextWindow: 1000, thresholdRatio: 0.5, retainTokens: 400, summarizationMaxTokens: 200,
    })).toThrow(/not below the compaction threshold/)
  })

  it('rejects the boundary case (sum equals the threshold — would re-trigger)', () => {
    // threshold = floor(1000 * 0.5) = 500; 100 + 400 = 500 is NOT below 500, so
    // post-compaction history would sit exactly at threshold and re-compact.
    expect(() => new BasicCompactService(new Context(), {
      auto: false, contextWindow: 1000, thresholdRatio: 0.5, retainTokens: 400, summarizationMaxTokens: 100,
    })).toThrow(/not below the compaction threshold/)
  })

  it('accepts the case just below the threshold', () => {
    // threshold = floor(1000 * 0.5) = 500; 99 + 400 = 499 < 500 → allowed.
    expect(() => new BasicCompactService(new Context(), {
      auto: false, contextWindow: 1000, thresholdRatio: 0.5, retainTokens: 400, summarizationMaxTokens: 99,
    })).not.toThrow()
  })

  it('the default config satisfies the invariant', () => {
    // 2048 + 20480 = 22528 ≤ floor(128000 * 0.8) = 102400.
    expect(() => new BasicCompactService(new Context(), { auto: false })).not.toThrow()
  })
})

/** An adapter that emits a fixed summary text, for exercising the real summarize() path. */
class ScriptedAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | null = null
  constructor(private summaryText: string) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.summaryText }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Wire a real LlmService + scripted adapter into a context. */
async function ctxWithModel(summaryText: string, model = 'test-model'): Promise<{ ctx: Context; adapter: ScriptedAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  const adapter = new ScriptedAdapter(summaryText)
  ctx.llm.registerAdapter([model], adapter)
  return { ctx, adapter }
}

/** An adapter whose stream ends with a finish chunk of the given reason (no content). */
class FinishOnlyAdapter extends LlmAdapter {
  constructor(private reason: StreamChunk & { type: 'finish' }) {
    super()
  }

  async * stream(): AsyncIterable<StreamChunk> {
    yield this.reason
  }
}

/** Wire a real LlmService + finish-only adapter into a context. */
async function ctxWithFinish(reason: (StreamChunk & { type: 'finish' })['reason'], model = 'test-model'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  ctx.llm.registerAdapter([model], new FinishOnlyAdapter({ type: 'finish', reason }))
  return ctx
}

/** A minimal Agent stub carrying just session + options (enough for the listeners). */
function stubAgent(session: Session, model?: string): Agent {
  return { session, options: { model } } as unknown as Agent
}

describe('BasicCompactService.summarize (real ctx.llm.stream)', () => {
  it('summarizes via the registered adapter and returns its content', async () => {
    const { ctx, adapter } = await ctxWithModel('SUMMARY TEXT')
    const svc = new BasicCompactService(ctx, { auto: false, summarizationMaxTokens: 512 })

    const summary = await svc.summarize('User: hi\n\nAssistant: hello', 'test-model')
    expect(summary).toEqual([{ type: 'text', text: 'SUMMARY TEXT' }])
    // The fixed system prompt and maxTokens flow through.
    expect(adapter.lastOptions!.system).toContain('compaction engine')
    expect(adapter.lastOptions!.system).toContain('## Next Step')
    expect(adapter.lastOptions!.maxTokens).toBe(512)
    expect(adapter.lastOptions!.messages[0]!.content[0]).toMatchObject({ type: 'text' })
  })

  it('throws when no model is provided', async () => {
    const { ctx } = await ctxWithModel('x')
    const svc = new BasicCompactService(ctx, { auto: false })
    await expect(svc.summarize('text', '')).rejects.toThrow(/no model available/)
  })

  it('rethrows when the stream ends with a finish-error chunk', async () => {
    const ctx = await ctxWithFinish({ kind: 'error', message: 'provider 401', code: 'UNAUTHORIZED' })
    const svc = new BasicCompactService(ctx, { auto: false })
    await expect(svc.summarize('text', 'test-model')).rejects.toMatchObject({ message: 'provider 401', code: 'UNAUTHORIZED' })
  })

  it('rethrows a finish-error chunk without a code (code stays undefined)', async () => {
    const ctx = await ctxWithFinish({ kind: 'error', message: 'opaque failure' })
    const svc = new BasicCompactService(ctx, { auto: false })
    const error = await svc.summarize('text', 'test-model').then(() => null, (e: unknown) => e as Error & { code?: string })
    expect(error?.message).toBe('opaque failure')
    expect(error?.code).toBeUndefined()
  })

  it('rethrows when the stream ends with a finish-aborted chunk', async () => {
    const ctx = await ctxWithFinish({ kind: 'aborted' })
    const svc = new BasicCompactService(ctx, { auto: false })
    await expect(svc.summarize('text', 'test-model')).rejects.toMatchObject({ message: 'summarization stream aborted', code: 'ABORTED' })
  })

  it('fails closed on a max-tokens finish (an incomplete checkpoint must not commit)', async () => {
    const ctx = await ctxWithFinish({ kind: 'max-tokens' })
    const svc = new BasicCompactService(ctx, { auto: false })
    await expect(svc.summarize('text', 'test-model')).rejects.toMatchObject({ code: 'MAX_TOKENS' })
  })

  it('compactRegion leaves the surface intact when summarization hits max-tokens', async () => {
    const ctx = await ctxWithFinish({ kind: 'max-tokens' })
    const svc = new BasicCompactService(ctx, { auto: false })
    const session = multiTurnSession(2, 1)
    const before = [...session.surface.nodes]
    const nodes = session.surface.nodes

    await expect(svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'test-model'))
      .rejects.toMatchObject({ code: 'MAX_TOKENS' })

    // No replacement landed — the surface is byte-identical, and the lock was
    // released with the error (compact/end carries it).
    expect(session.surface.nodes).toEqual(before)
    const endEvent = session.events.findLast(e => e.type === 'compact/end')!
    const endData = endEvent.data as { error?: string }
    expect(endData.error).toContain('truncated')
  })

  it('compactRegion uses the real summarizer end-to-end', async () => {
    const { ctx } = await ctxWithModel('CONDENSED')
    const svc = new BasicCompactService(ctx, { auto: false })
    const session = multiTurnSession(2, 1)
    const nodes = session.surface.nodes

    const result = await svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'test-model')
    expect(result.summary).toEqual([{ type: 'text', text: 'CONDENSED' }])
    // The raw summary is wrapped in the checkpoint framing on the surface.
    expect(session.deriveMessages()[0]!.content).toContainEqual({ type: 'text', text: 'CONDENSED' })
  })
})

describe('BasicCompactService auto-compaction (agent/pre-step listener)', () => {
  /** Fire the agent/pre-step serial checkpoint as the loop does. */
  function firePreStep(ctx: Context, agent: Agent, step: number, system: string, model: string): Promise<unknown> {
    return ctx.serial('agent/pre-step', agent, 1, step, system, model, SIGNAL)
  }

  it('compacts (mutating the surface) when over threshold', async () => {
    const { ctx } = await ctxWithModel('SUMMARY')
    void new BasicCompactService(ctx, { contextWindow: 200, thresholdRatio: 0.5, retainTokens: 20, summarizationMaxTokens: 50 })
    const session = multiTurnSession(5, 1) // 10 surface nodes
    const agent = stubAgent(session, 'test-model')
    const before = session.surface.nodes.length

    await firePreStep(ctx, agent, 1, '', 'test-model')

    // The surface shrank in place, and a summary checkpoint landed.
    expect(session.surface.nodes.length).toBeLessThan(before)
    expect(session.events.some(e => e.type === 'compact/summary')).toBe(true)
    // The re-derived head message is the framed summary checkpoint.
    expect(session.deriveMessages()[0]!.content).toContainEqual({ type: 'text', text: 'SUMMARY' })
  })

  it('compacts mid-turn on steps after the first (the surface grows within a turn)', async () => {
    const { ctx } = await ctxWithModel('SUMMARY')
    void new BasicCompactService(ctx, { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 10, summarizationMaxTokens: 30 })
    const session = multiTurnSession(3, 1) // over the 0.5 threshold
    const agent = stubAgent(session, 'test-model')

    // A step-2 checkpoint (a tool-heavy turn's later step) must still compact —
    // the surface accumulated assistant/message + tool/result nodes since step 1.
    await firePreStep(ctx, agent, 2, '', 'test-model')
    expect(session.events.some(e => e.type === 'compact/start')).toBe(true)
  })

  it('does nothing when under threshold', async () => {
    const { ctx } = await ctxWithModel('SUMMARY')
    void new BasicCompactService(ctx, { contextWindow: 128000, thresholdRatio: 0.8 })
    const session = multiTurnSession(1, 1)
    const agent = stubAgent(session, 'test-model')

    await firePreStep(ctx, agent, 1, '', 'test-model')
    expect(session.events.some(e => e.type === 'compact/start')).toBe(false)
  })

  it('leaves the surface intact when compaction fails (summarize rejects)', async () => {
    // No adapter registered for this model → summarize() rejects → caught, the
    // surface is untouched (the loop derives the full history).
    const ctx = new Context()
    await ctx.plugin(LlmService)
    void new BasicCompactService(ctx, { contextWindow: 300, thresholdRatio: 0.1, retainTokens: 10, summarizationMaxTokens: 1 })
    const session = multiTurnSession(3, 1)
    const agent = stubAgent(session, 'missing-model')
    const before = session.surface.nodes.length

    await firePreStep(ctx, agent, 1, '', 'missing-model')
    // No summary landed; the surface is unchanged.
    expect(session.events.some(e => e.type === 'compact/summary')).toBe(false)
    expect(session.surface.nodes.length).toBe(before)
  })

  it('does not register the listener when auto is false', async () => {
    const { ctx } = await ctxWithModel('SUMMARY')
    void new BasicCompactService(ctx, { auto: false, contextWindow: 100, thresholdRatio: 0.1, retainTokens: 5, summarizationMaxTokens: 1 })
    const session = multiTurnSession(3, 1)
    const agent = stubAgent(session, 'test-model')

    await firePreStep(ctx, agent, 1, '', 'test-model')
    expect(session.events.some(e => e.type === 'compact/start')).toBe(false)
  })
})

describe('BasicCompactService._extractText branches', () => {
  it('renders reasoning, context, and steering messages', async () => {
    const svc = createTestService()
    const s = new Session(SessionId('rich'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('context/message', {
      content: [{ type: 'text', text: 'project context here' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [{ type: 'reasoning', text: 'thinking hard' }, { type: 'text', text: 'answer' }],
    }, { surfaceOp: 'append' })
    s.append('steering/message', {
      turn: 1,
      content: [{ type: 'text', text: 'steer this way' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })

    const nodes = s.surface.nodes
    await svc.compactRegion(s, nodes[0]!.seq, nodes[nodes.length - 1]!.seq, 'm')

    const { text } = svc.summarizeCalls[0]!
    expect(text).toContain('[Context: project context here]')
    expect(text).toContain('[reasoning: thinking hard]')
    expect(text).toContain('[Steering: steer this way]')
  })

  it('labels tool errors distinctly from tool results', async () => {
    const svc = createTestService()
    const s = new Session(SessionId('toolerr'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [{ type: 'tool-call', id: CallId('c9'), name: 'bash', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    s.append('tool/call', { turn: 1, step: 1, callId: CallId('c9'), name: 'bash', arguments: '{}' })
    s.append('tool/result', {
      turn: 1, step: 1, callId: CallId('c9'),
      content: [{ type: 'text', text: 'boom failure' }],
      isError: true,
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })

    const nodes = s.surface.nodes
    await svc.compactRegion(s, nodes[0]!.seq, nodes[nodes.length - 1]!.seq, 'm')
    expect(svc.summarizeCalls[0]!.text).toContain('Tool error (call c9): boom failure')
  })
})

describe('BasicCompactService edge cases', () => {
  it('renders bare and nested tool-result placeholders and unknown blocks', async () => {
    const svc = createTestService()
    const s = new Session(SessionId('toolresult'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    // assistant/message carrying a nested tool-result block, an unknown block,
    // and the tool-call that the following tool/result answers (so the surface
    // is tool-pairing balanced).
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [
        { type: 'tool-result', toolCallId: CallId('n1'), content: [{ type: 'image', url: 'https://x/n.png' }] },
        { type: 'custom-widget', payload: 'x' } as unknown as ContentBlock,
        { type: 'tool-call', id: CallId('b1'), name: 'bash', arguments: '{}' },
      ],
    }, { surfaceOp: 'append' })
    // tool/result whose content is itself only non-text → bare '[tool-result]'.
    s.append('tool/call', { turn: 1, step: 1, callId: CallId('b1'), name: 'bash', arguments: '{}' })
    s.append('tool/result', {
      turn: 1, step: 1, callId: CallId('b1'),
      content: [{ type: 'tool-result', toolCallId: CallId('inner'), content: [] }],
      isError: false,
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })

    const nodes = s.surface.nodes
    await svc.compactRegion(s, nodes[0]!.seq, nodes[nodes.length - 1]!.seq, 'm')
    const { text } = svc.summarizeCalls[0]!
    expect(text).toContain('[tool-result: [image]]') // nested tool-result with content
    expect(text).toContain('[custom-widget]') // unknown block placeholder
    expect(text).toContain('Tool result (call b1): [tool-result]') // empty nested → bare placeholder
  })

  it('estimates unknown block types via JSON length (default branch)', () => {
    const svc = new BasicCompactService(new Context(), { auto: false })
    // A block whose type is none of the known kinds — exercises the default arm.
    const unknown = { type: 'custom-widget', payload: 'some data' } as unknown as ContentBlock
    expect(svc.estimateContentTokens([unknown])).toBeGreaterThan(0)
  })

  it('compacts once without re-checking a post-compaction threshold', async () => {
    const { ctx } = await ctxWithModel('SUMMARY')
    // Even with a window so tiny the post-compaction history still exceeds the
    // threshold, the agnostic listener does NOT re-gate or warn — it compacts
    // once (the single check lives in compactIfNeeded) and proceeds.
    const warnings: string[] = []
    ctx.logger.warn = ((msg: string) => void warnings.push(msg)) as typeof ctx.logger.warn
    void new BasicCompactService(ctx, { contextWindow: 300, thresholdRatio: 0.1, retainTokens: 5, summarizationMaxTokens: 5 })
    const session = multiTurnSession(4, 1)
    const agent = stubAgent(session, 'test-model')

    await ctx.serial('agent/pre-step', agent, 1, 1, '', 'test-model', SIGNAL)
    expect(session.events.some(e => e.type === 'compact/summary')).toBe(true)
    // The surface was mutated; the head message is the framed summary checkpoint.
    expect(session.deriveMessages()[0]!.content).toContainEqual({ type: 'text', text: 'SUMMARY' })
    // No cascade warning is emitted.
    expect(warnings.length).toBe(0)
  })

  it('rejects compaction when no turn is open (compaction events must be turn-enclosed)', async () => {
    const svc = createTestService()
    // A session whose only turn has CLOSED — scanning back from the tail hits
    // turn/end before any turn/start, so there is no open turn to enclose
    // compaction's compact/* + replacement events, which the log contract forbids.
    const s = new Session(SessionId('noturn'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { content: [{ type: 'text', text: 'orphan' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'text', text: 'reply' }] }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const nodes = s.surface.nodes

    await expect(svc.compactRegion(s, nodes[0]!.seq, nodes[1]!.seq, 'm'))
      .rejects.toThrow(/no open turn/)
    // The lock was never acquired — no compact/start landed.
    expect(s.events.some(e => e.type === 'compact/start')).toBe(false)
  })

  it('rejects compaction on a session with no turn boundaries at all', async () => {
    const svc = createTestService()
    // No turn events whatsoever — the open-turn scan falls through to the end
    // of the log and finds none, so compaction is rejected (its events have no
    // turn to enclose them).
    const s = new Session(SessionId('turnless'))
    s.append('user/message', { content: [{ type: 'text', text: 'orphan' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const nodes = s.surface.nodes

    await expect(svc.compactRegion(s, nodes[0]!.seq, nodes[0]!.seq, 'm'))
      .rejects.toThrow(/no open turn/)
    expect(s.events.some(e => e.type === 'compact/start')).toBe(false)
  })

  it('compactIfNeeded returns null for empty surface even when over threshold', async () => {
    const svc = createTestService({ contextWindow: 1000, thresholdRatio: 0.1, retainTokens: 5 })
    const session = new Session(SessionId('empty-but-pressured'))
    // No surface nodes, but a large system prompt pushes the estimate over threshold.
    const bigPrompt = 'x'.repeat(800) // ceil(800/4) = 200 tokens >> threshold 100
    expect(await svc.compactIfNeeded(session, bigPrompt, 'm', SIGNAL)).toBeNull()
  })

  it('compactRegion throws when end is not a surface node (start valid)', async () => {
    const svc = createTestService()
    const session = multiTurnSession(1, 1)
    const nodes = session.surface.nodes
    await expect(svc.compactRegion(session, nodes[0]!.seq, 9999, 'm'))
      .rejects.toThrow(/end seq 9999 not found in surface/)
  })

  it('compactRegion stringifies a non-Error thrown by summarize', async () => {
    const svc = createTestService()
    // Throw a non-Error value to exercise the String(error) branch in the catch.
    svc.summarizeError = 'plain string failure' as unknown as Error
    const session = multiTurnSession(1, 1)
    const nodes = session.surface.nodes

    // Whole step (user → assistant): a step-aligned region that reaches summarize.
    await expect(svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'm')).rejects.toBe('plain string failure')
    const endEvent = session.events.findLast(e => e.type === 'compact/end')!
    expect(endEvent.data).toMatchObject({ error: 'plain string failure' })
  })

  it('auto-compaction listener stringifies a non-Error and proceeds', async () => {
    const { ctx } = await ctxWithModel('SUMMARY')
    const warnings: string[] = []
    ctx.logger.warn = ((msg: string) => void warnings.push(msg)) as typeof ctx.logger.warn
    const svc = new TestCompactService(ctx, { contextWindow: 300, thresholdRatio: 0.1, retainTokens: 10, summarizationMaxTokens: 10 })
    svc.summarizeError = 'boom' as unknown as Error
    const session = multiTurnSession(3, 1)
    const agent = stubAgent(session, 'test-model')
    const before = session.surface.nodes.length

    await ctx.serial('agent/pre-step', agent, 1, 1, '', 'test-model', SIGNAL)
    // The failure was swallowed; the surface is untouched and a warning logged.
    expect(session.surface.nodes.length).toBe(before)
    expect(session.events.some(e => e.type === 'compact/summary')).toBe(false)
    expect(warnings.some(w => w.includes('compaction failed: boom'))).toBe(true)
  })

  it('auto-compaction listener takes the result-null branch (nothing to compact)', async () => {
    const { ctx } = await ctxWithModel('SUMMARY')
    // A large system prompt pushes the listener's estimate over threshold, but
    // retainTokens is huge so compactIfNeeded walks everything and returns null.
    // threshold = floor(2000*0.1) = 200; invariant: 5 + 150 = 155 ≤ 200.
    const svc = new TestCompactService(ctx, { contextWindow: 2000, thresholdRatio: 0.1, retainTokens: 150, summarizationMaxTokens: 5 })
    const session = multiTurnSession(2, 1)
    const agent = stubAgent(session, 'test-model')
    const bigSystem = 'x'.repeat(900) // ceil(900/4)=225 > threshold 200

    await ctx.serial('agent/pre-step', agent, 1, 1, bigSystem, 'test-model', SIGNAL)
    expect(session.events.some(e => e.type === 'compact/start')).toBe(false)
    expect(svc.summarizeCalls.length).toBe(0)
  })

  it('skips messages whose extracted text is empty across all kinds', async () => {
    const svc = createTestService()
    const s = new Session(SessionId('empties'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // Step 1: an empty-text user, an empty-reasoning assistant with NO tool-call
    // (balanced: nothing to answer), and empty context/steering — all extract to
    // nothing and are skipped.
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { content: [{ type: 'text', text: '' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, content: [{ type: 'reasoning', text: '' }] }, { surfaceOp: 'append' })
    s.append('context/message', { content: [], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('steering/message', { turn: 1, content: [{ type: 'text', text: '' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    // Step 2: a tool exchange whose tool/result has empty content → empty
    // extraction → skipped. The assistant carries the matching tool-call so the
    // surface stays tool-pairing balanced; its text extracts to the tool-call
    // placeholder (the one surviving line).
    s.append('step/start', { turn: 1, step: 2 })
    s.append('assistant/message', {
      turn: 1, step: 2,
      content: [{ type: 'tool-call', id: CallId('z1'), name: 'bash', arguments: '{}' }],
    }, { surfaceOp: 'append' })
    s.append('tool/call', { turn: 1, step: 2, callId: CallId('z1'), name: 'bash', arguments: '{}' })
    s.append('tool/result', { turn: 1, step: 2, callId: CallId('z1'), content: [], isError: false }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 2 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })

    const nodes = s.surface.nodes
    await svc.compactRegion(s, nodes[0]!.seq, nodes[nodes.length - 1]!.seq, 'm')
    // Every empty-content message (user text, empty reasoning, empty-content
    // tool/result, empty context, empty steering) extracted to nothing and was
    // skipped — the only surviving line is the assistant's tool-call (which a
    // balanced surface requires to answer the tool/result).
    expect(svc.summarizeCalls[0]!.text).toBe('Assistant: [tool-call: bash({})]')
  })

  it('renders non-text blocks as type-tagged placeholders across all message kinds', async () => {
    const svc = createTestService()
    const s = new Session(SessionId('placeholders'))
    s.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    s.append('step/start', { turn: 1, step: 1 })
    // user/message with only an image block → '[image]' placeholder.
    s.append('user/message', { content: [{ type: 'image', url: 'https://x/y.png' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    // assistant/message with an image block AND the tool-call its tool/result
    // answers (so the surface is tool-pairing balanced) → '[image]' placeholder.
    s.append('assistant/message', {
      turn: 1, step: 1,
      content: [
        { type: 'image', url: 'https://x/z.png' },
        { type: 'tool-call', id: CallId('e1'), name: 'bash', arguments: '{}' },
      ],
    }, { surfaceOp: 'append' })
    // tool/result with an image block → '[image]' placeholder.
    s.append('tool/call', { turn: 1, step: 1, callId: CallId('e1'), name: 'bash', arguments: '{}' })
    s.append('tool/result', { turn: 1, step: 1, callId: CallId('e1'), content: [{ type: 'image', url: 'https://x/r.png' }], isError: false }, { surfaceOp: 'append' })
    // context/message and steering/message with image content.
    s.append('context/message', { content: [{ type: 'image', url: 'https://x/c.png' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('steering/message', { turn: 1, content: [{ type: 'image', url: 'https://x/s.png' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    s.append('turn/start', { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } })

    const nodes = s.surface.nodes
    await svc.compactRegion(s, nodes[0]!.seq, nodes[nodes.length - 1]!.seq, 'm')
    const { text } = svc.summarizeCalls[0]!
    // Every non-text block surfaces as a placeholder rather than being dropped.
    expect(text).toContain('User: [image]')
    expect(text).toContain('Assistant: [image]')
    expect(text).toContain('Tool result (call e1): [image]')
    expect(text).toContain('[Context: [image]]')
    expect(text).toContain('[Steering: [image]]')
  })

})

describe('BasicCompactService positional range (surface seqs are not monotonic after a replace)', () => {
  it('compacts a second region after the first replace lands a high-seq summary at the head position', async () => {
    // A replace inserts the new summary node (a high seq) AT the shadowed
    // range's surface position, so the surface becomes
    // [highSeqSummary, …olderRetainedLowerSeqs]. A second compaction over a
    // range whose start node has a HIGHER seq than its end node must still
    // succeed — the range is positional, not a numeric seq interval.
    const svc = createTestService({ auto: false })
    const session = multiTurnSession(4, 1)

    // First compaction: shadow the two oldest surface nodes.
    const nodes0 = session.surface.nodes
    const first = await svc.compactRegion(session, nodes0[0]!.seq, nodes0[1]!.seq, 'm')

    // The summary node now sits at the head with a seq HIGHER than the
    // retained older nodes that follow it — the non-monotonic surface. (The
    // head is the user/message replace node, appended after the compact/summary
    // provenance event, so its seq is at least first.summarySeq.)
    const nodes1 = session.surface.nodes
    expect(nodes1[0]!.seq).toBeGreaterThanOrEqual(first.summarySeq)
    expect(nodes1[0]!.seq).toBeGreaterThan(nodes1[1]!.seq)

    // Second compaction: shadow [summary(head) … turn-2's step end]. The start
    // seq (the head summary node) is GREATER than the end seq (an older retained
    // node), so the range is a SURFACE-POSITION span, not a numeric seq interval.
    // The end must land on a step boundary (turn-2's assistant message closes
    // its step).
    const startSeq = nodes1[0]!.seq
    const endSeq = nodes1[2]!.seq
    expect(startSeq).toBeGreaterThan(endSeq)
    const second = await svc.compactRegion(session, startSeq, endSeq, 'm')

    // Exactly the three nodes at surface positions [0..2] are shadowed, in
    // surface order — the positional slice, regardless of their seq values.
    expect(second.shadowedSeqs).toEqual([nodes1[0]!.seq, nodes1[1]!.seq, nodes1[2]!.seq])
    // The surface still derives cleanly: a new head replace node + the rest.
    const finalNodes = session.surface.nodes
    expect(finalNodes[0]!.seq).toBeGreaterThanOrEqual(second.summarySeq)
    expect(session.deriveMessages().length).toBe(finalNodes.length)
  })

  it('extracts the second-compaction transcript in surface order, not log-seq order', async () => {
    const svc = createTestService({ auto: false })
    const session = multiTurnSession(3, 1)

    // First compaction shadows the oldest two surface nodes, landing a high-seq
    // summary node at the head.
    const n0 = session.surface.nodes
    await svc.compactRegion(session, n0[0]!.seq, n0[1]!.seq, 'm')

    // Second compaction spans [head summary … turn-2's step end]. The head's seq
    // is higher than the older retained nodes' seqs, so a log-seq-order walk
    // would emit the older messages BEFORE the checkpoint.
    const n1 = session.surface.nodes
    svc.summarizeCalls = []
    await svc.compactRegion(session, n1[0]!.seq, n1[2]!.seq, 'm')

    // The extracted transcript follows surface order: the checkpoint (head)
    // first, then the older retained messages — matching deriveMessages().
    const { text } = svc.summarizeCalls[0]!
    const checkpointIdx = text.indexOf('compacted-summary')
    const olderIdx = text.indexOf('turn 2 user')
    expect(checkpointIdx).toBeGreaterThanOrEqual(0)
    expect(olderIdx).toBeGreaterThan(checkpointIdx)
  })
})

describe('BasicCompactService llm inject (real plugin-load path)', () => {
  it('declares llm in static inject so a sibling fiber can resolve ctx.llm', () => {
    // summarize() reads ctx.llm; the inject lets the cordis ctx proxy resolve a
    // sibling LlmService when this service is mounted as its own plugin fiber.
    // Asserting the declaration (and exercising the real mount below) guards the
    // resolution that root-ctx unit tests cannot, since they share one fiber.
    expect(BasicCompactService.inject).toContain('llm')
  })

  it('resolves ctx.llm and summarizes when mounted as a sibling plugin of LlmService', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter('CONDENSED'))
    // Mount the service through its real plugin fiber (NOT new …(rootCtx)), so
    // the sibling-fiber ctx.llm resolution actually exercises the inject.
    const fiber = await ctx.plugin(BasicCompactService, { auto: false })

    const svc = ctx.compact as BasicCompactService
    const session = multiTurnSession(2, 1)
    const nodes = session.surface.nodes
    const result = await svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'test-model')
    expect(result.summary).toEqual([{ type: 'text', text: 'CONDENSED' }])

    // Tear the fiber down so this test owns no leaked registration; the
    // dedicated cleanup assertion lives in the "HMR safety" suite.
    await fiber.dispose()
    expect(ctx.get('compact')).toBeUndefined()
  })
})

describe('BasicCompactService under the real invariants plugin', () => {
  /**
   * Drive compaction through a session whose `session/event` listeners include
   * the real dev-mode invariants plugin (as a real app loads it via agent-core).
   * The invariants throw on append, so a passing run proves the compaction
   * sequence is contract-valid: every event is turn-enclosed, and the positional
   * replace op is accepted even when the surface is no longer seq-ordered.
   */
  async function setup(): Promise<{ ctx: Context; session: Session; svc: BasicCompactService }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants, {})
    await ctx.plugin(LlmService)
    ctx.llm.registerAdapter(['test-model'], new ScriptedAdapter('CONDENSED'))
    await ctx.plugin(BasicCompactService, { auto: false })
    const session = ctx.sessions.create()
    return { ctx, session, svc: ctx.compact as BasicCompactService }
  }

  /** Append one closed turn of [user, assistant] surface nodes via the store. */
  function closedTurn(session: Session, turn: number): void {
    session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', { content: [{ type: 'text', text: `turn ${turn} user` }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn, step: 1, content: [{ type: 'text', text: `turn ${turn} assistant` }] }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  it('runs a turn-enclosed compaction whose positional replace the invariants accept', async () => {
    const { session, svc } = await setup()
    closedTurn(session, 1)
    closedTurn(session, 2)
    // Open turn 3, as the loop has when the auto-compaction listener fires.
    session.append('turn/start', { turn: 3, trigger: { kind: 'message', source: { kind: 'user' } } })

    const nodes = session.surface.nodes
    // No invariant throws here: compact/* + the replacement are all in turn 3.
    const result = await svc.compactRegion(session, nodes[0]!.seq, nodes[1]!.seq, 'test-model')
    expect(result.shadowedSeqs.length).toBe(2)
    expect(session.surface.nodes[0]!.seq).toBeGreaterThan(session.surface.nodes[1]!.seq)
  })

  it('accepts a second compaction over the non-monotonic surface left by the first', async () => {
    const { session, svc } = await setup()
    closedTurn(session, 1)
    closedTurn(session, 2)
    closedTurn(session, 3)
    session.append('turn/start', { turn: 4, trigger: { kind: 'message', source: { kind: 'user' } } })

    const n0 = session.surface.nodes
    await svc.compactRegion(session, n0[0]!.seq, n0[1]!.seq, 'test-model')

    // Surface head now carries a higher seq than the older retained nodes. A
    // second compaction spanning [head … a later closed-step end] must pass the
    // invariants' positional replace check even though startSeq > endSeq.
    const n1 = session.surface.nodes
    expect(n1[0]!.seq).toBeGreaterThan(n1[2]!.seq)
    const second = await svc.compactRegion(session, n1[0]!.seq, n1[2]!.seq, 'test-model')
    expect(second.shadowedSeqs).toEqual([n1[0]!.seq, n1[1]!.seq, n1[2]!.seq])
  })
})

