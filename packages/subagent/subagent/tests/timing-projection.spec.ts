import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { subagentTimingProjectionDefinition } from '../src/projection.ts'

function event(type: SessionEvent['type'], seq: number, time: number): SessionEvent {
  return { type, seq, time, data: {} } as SessionEvent
}

function fold(events: SessionEvent[]) {
  let state = subagentTimingProjectionDefinition.init()
  for (const item of events) state = subagentTimingProjectionDefinition.apply(state, item)
  return subagentTimingProjectionDefinition.view(state)
}

describe('subagent timing projection', () => {
  it('resets inherited seed timing at the child descriptor and sums later completed turns', () => {
    expect(fold([
      event('turn/start', 0, 100),
      event('subagent/descriptor', 1, 110),
      event('turn/end', 2, 300),
      event('turn/start', 3, 1_000),
      event('subagent/descriptor', 4, 1_100),
      event('turn/end', 5, 4_100),
      event('turn/start', 6, 10_000),
      event('turn/end', 7, 12_000),
    ])).toEqual({ settledMs: 5_100 })
  })

  it('exposes an open turn start and never subtracts time for reversed boundaries', () => {
    expect(fold([
      event('turn/start', 0, 1_000),
      event('subagent/descriptor', 1, 1_100),
      event('turn/end', 2, 900),
      event('turn/start', 3, 2_000),
      event('assistant/chunk', 4, 2_500),
    ])).toEqual({ settledMs: 0, activeSince: 2_000 })
  })

  it('ignores completed pre-descriptor turns and unrelated events', () => {
    const initial = subagentTimingProjectionDefinition.init()
    expect(subagentTimingProjectionDefinition.apply(
      initial,
      event('assistant/chunk', 0, 1),
    )).toBe(initial)
    expect(fold([
      event('turn/start', 0, 100),
      event('turn/end', 1, 200),
      event('subagent/descriptor', 2, 300),
    ])).toEqual({ settledMs: 0 })
  })
})
