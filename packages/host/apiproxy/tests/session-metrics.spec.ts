import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { affectsSessionMetrics, SessionMetricsProjector } from '../src/session-metrics.ts'

function assistant(
  session: Session,
  turn: number,
  step: number,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
): void {
  session.append('assistant/chunk', {
    turn,
    step,
    chunk: { type: 'usage', usage },
  })
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `answer-${turn}-${step}` }],
      source: { provider: 'test', model: 'alpha' },
    }),
    usage,
  }, { surfaceOp: 'append' })
}

describe('SessionMetricsProjector', () => {
  it('filters text/reasoning deltas while retaining usage, headers, and surface mutations', () => {
    const session = new Session(SessionId('metrics-filter'))
    const text = session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x' },
    })
    const usage = session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    })
    const header = session.append('request/header', {
      header: { config: { provider: 'test', model: 'alpha' } },
      reason: 'initial',
    })
    const surface = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const plain = session.append('step/start', { turn: 1, step: 1 })

    expect(affectsSessionMetrics(text)).toBe(false)
    expect(affectsSessionMetrics(usage)).toBe(true)
    expect(affectsSessionMetrics(header)).toBe(true)
    expect(affectsSessionMetrics(surface)).toBe(true)
    expect(affectsSessionMetrics(plain)).toBe(false)
  })

  it('folds usage by turn and step while synchronous pressure follows surface replacement', () => {
    const ctx = new Context()
    ctx.provide('tokenMeter', {
      measure(session: Session) {
        return { totalTokens: session.surface.nodes.length * 100 }
      },
    })
    const session = new Session(SessionId('metrics-fold'))
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'large old surface' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    assistant(session, 1, 1, {
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 89,
      cacheWriteTokens: 8,
    })

    const projector = new SessionMetricsProjector(ctx)
    expect(projector.snapshot(session)).toMatchObject({
      uncachedInputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 89,
      cacheWriteTokens: 8,
      contextTokens: 200,
    })

    const assistantSeq = session.surface.nodes.at(-1)
    if (assistantSeq === undefined) throw new Error('assistant surface missing')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compact summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: first.seq, end: assistantSeq },
      sourceEventSeqs: [first.seq, assistantSeq],
    })
    expect(projector.snapshot(session)).toMatchObject({
      uncachedInputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 89,
      cacheWriteTokens: 8,
      contextTokens: 100,
    })

    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: {
        type: 'usage',
        usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 88, cacheWriteTokens: 9 },
      },
    })
    assistant(session, 1, 2, { inputTokens: 1_000, outputTokens: 500 })

    expect(projector.snapshot(session)).toMatchObject({
      logRevision: session.events.length,
      projectionRevision: 2,
      uncachedInputTokens: 1_012,
      outputTokens: 504,
      cacheReadTokens: 88,
      cacheWriteTokens: 9,
      contextTokens: 200,
    })
  })

  it('omits pressure when the token meter is absent or cannot measure the replay', () => {
    const session = new Session(SessionId('metrics-pressure-unknown'))
    const withoutMeter = new SessionMetricsProjector(new Context()).snapshot(session)
    expect(withoutMeter.contextTokens).toBeUndefined()

    const ctx = new Context()
    ctx.provide('tokenMeter', {
      measure() {
        throw new Error('unmeasurable replay')
      },
    })
    expect(new SessionMetricsProjector(ctx).snapshot(session).contextTokens).toBeUndefined()
  })
})
