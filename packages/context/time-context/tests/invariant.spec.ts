import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as TimeInvariant from '@deepseek-ai/dsh-time-context/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

const SECOND = Date.parse('2026-07-14T00:00:00Z')

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantService)
  await ctx.plugin(TimeInvariant)
  return ctx
}

function event(text: string, time = SECOND + 456, content?: unknown[]): SessionEvent {
  return {
    type: 'context/message',
    seq: 0,
    time,
    data: {
      content: (content ?? [{ type: 'text', text }]) as ContentBlock[],
      source: { kind: 'plugin', plugin: 'time-context' },
    },
  }
}

function reading(
  turn = '1',
  step = '1',
  baseline = 'model-visible message',
  timestamp = '2026-07-14T00:00:00+00:00[UTC]',
): string {
  return `Time sampled while preparing turn ${turn}, step ${step}: ${timestamp}\n`
    + `Elapsed since the preceding ${baseline}: unavailable.`
}

function preparing(turn: number, step: number): Session {
  const session = new Session(SessionId(`time-invariant-${turn}-${step}`))
  for (let priorTurn = 1; priorTurn < turn; priorTurn += 1) {
    session.append('turn/start', { turn: priorTurn, trigger: { kind: 'message', source: { kind: 'user' } } })
    session.append('turn/end', { turn: priorTurn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append('user/message', {
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  for (let priorStep = 1; priorStep < step; priorStep += 1) {
    session.append('step/start', { turn, step: priorStep })
    session.append('step/end', { turn, step: priorStep })
  }
  return session
}

describe('time-context invariants', () => {
  it('accepts a reading whose turn, step, baseline, and timestamp agree', async () => {
    const ctx = await setup()
    const text = 'Time sampled while preparing turn 2, step 3: 2026-07-14T00:00:00+00:00[UTC]\n'
      + 'Elapsed since the preceding step context: 4m 2s.'
    expect(() => { ctx.emit('session/event', preparing(2, 3), event(text)) }).not.toThrow()
  })

  it.each([
    [reading('1', '3', 'step context'), /expected turn 2\/step 3/],
    [reading('2', '2', 'step context'), /expected turn 2\/step 3/],
  ])('rejects a reading that disagrees with its session position', async (text, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(2, 3), event(text)) }).toThrow(message)
  })

  it('rejects a reading after cancellation closes the turn', async () => {
    const ctx = await setup()
    const session = preparing(1, 2)
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'cancelled' } })
    expect(() => { ctx.emit('session/event', session, event(reading('1', '2', 'step context'))) })
      .toThrow(/inside an open turn/)
  })

  it('rejects a reading after step/start or without any open turn', async () => {
    const ctx = await setup()
    const started = preparing(1, 1)
    started.append('step/start', { turn: 1, step: 1 })
    expect(() => { ctx.emit('session/event', started, event(reading())) }).toThrow(/must precede step\/start/)
    expect(() => {
      ctx.emit('session/event', new Session(SessionId('time-invariant-empty')), event(reading()))
    }).toThrow(/inside an open turn/)
  })

  it.each([
    ['not a reading', SECOND, undefined, /durable reading format/],
    [reading('0'), SECOND, undefined, /positive safe integers/],
    [reading('999999999999999999999'), SECOND, undefined, /positive safe integers/],
    [reading('1', '0', 'step context'), SECOND, undefined, /positive safe integers/],
    [reading('1', '999999999999999999999', 'step context'), SECOND, undefined, /positive safe integers/],
    [reading('1', '1', 'step context'), SECOND, undefined, /wrong elapsed-time baseline/],
    [reading('1', '2', 'model-visible message'), SECOND, undefined, /wrong elapsed-time baseline/],
    [reading('1', '1', 'model-visible message', '2026-99-99T00:00:00+00:00[UTC]'), SECOND, undefined, /durable event second/],
    [reading(), Number.NaN, undefined, /durable event second/],
    [reading(), SECOND - 1, undefined, /durable event second/],
    [reading(), SECOND + 1_000, undefined, /durable event second/],
    ['ignored', SECOND, [], /exactly one text block/],
    ['ignored', SECOND, [{ type: 'image', data: 'x', mimeType: 'image/png' }], /exactly one text block/],
    ['ignored', SECOND, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], /exactly one text block/],
  ] as const)('rejects an incoherent durable reading', async (text, time, content, message) => {
    const ctx = await setup()
    const preparationStep = text.includes('turn 1, step 2:') ? 2 : 1
    expect(() => {
      ctx.emit('session/event', preparing(1, preparationStep), event(
        text,
        time,
        content === undefined ? undefined : [...content],
      ))
    }).toThrow(message)
  })

  it('ignores context messages owned by another package', async () => {
    const ctx = await setup()
    const other = event('unrelated') as SessionEvent<'context/message'>
    other.data.source = { kind: 'plugin', plugin: 'other' }
    expect(() => { ctx.emit('session/event', preparing(1, 1), other) }).not.toThrow()
    other.data.source = { kind: 'user' }
    expect(() => { ctx.emit('session/event', preparing(1, 1), other) }).not.toThrow()
    expect(() => {
      ctx.emit('session/event', preparing(1, 1), {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      })
      ctx.emit('tools/change')
    }).not.toThrow()
  })
})
