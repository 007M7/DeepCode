import { describe, expect, it } from 'vitest'
import { buildTraceGraph, type TraceEvent } from '../src/trace-graph.ts'

describe('desktop trace graph', () => {
  it('shares one paired tool target across chat, trajectory, waterfall, and inspector payloads', () => {
    const graph = buildTraceGraph('s1', fixture())
    const tool = graph.targets.get('tool:c1')!
    expect(tool.input).toEqual({ command: 'pwd' })
    expect(tool.output).toMatchObject({ content: [{ type: 'text', text: '/repo' }], isError: false })
    expect(graph.chatTurns[0]?.activities).toContainEqual({ kind: 'tool', targetId: 'tool:c1' })
    expect(graph.trajectoryRows.filter(row => row.targetId === 'tool:c1')).toHaveLength(1)
    expect(graph.waterfallSpans.filter(span => span.targetId === 'tool:c1')).toHaveLength(1)
    expect(graph.trajectoryRows.some(row => row.targetId.includes('result'))).toBe(false)
    expect(graph.trajectoryRows.some(row => ['turn', 'step'].includes(graph.targets.get(row.targetId)?.kind ?? ''))).toBe(false)
    expect(graph.trajectoryRows.some(row => graph.targets.get(row.targetId)?.kind === 'request')).toBe(false)
  })

  it('groups multiple model steps into one chat response while preserving selectable blocks', () => {
    const graph = buildTraceGraph('s1', fixture())
    expect(graph.chatTurns).toHaveLength(1)
    expect(graph.chatTurns[0]?.activities.map(activity => activity.targetId)).toEqual([
      'reasoning:1:1',
      'tool:c1',
      'reasoning:1:2',
      'assistant:14',
    ])
    expect(graph.trajectoryRows.map(row => row.targetId)).toContain('assistant:6')
    expect(graph.targets.get('reasoning:1:1')?.output).toBe('think one')
    expect(graph.targets.get('assistant:14')?.output).toEqual([
      { type: 'reasoning', text: 'think two' },
      { type: 'text', text: 'done' },
    ])
  })

  it('folds todo/write events into plan targets and chat activities', () => {
    const graph = buildTraceGraph('s-plan', [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' } } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'go' }] } },
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      { type: 'todo/write', seq: 3, time: 4, data: { turn: 1, step: 1, todos: [
        { content: 'read the code', status: 'completed' },
        { content: 'fix the bug', status: 'in_progress' },
      ] } },
      { type: 'todo/write', seq: 4, time: 5, data: { turn: 1, step: 1 } },
      { type: 'todo/write', data: { turn: 1, step: 1, todos: [{ content: 'seqless snapshot', status: 'pending' }] } },
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const plan = graph.targets.get('plan:3')!
    expect(plan.kind).toBe('plan')
    expect(plan.output).toEqual([
      { content: 'read the code', status: 'completed' },
      { content: 'fix the bug', status: 'in_progress' },
    ])
    expect(graph.targets.get('plan:4')?.output).toEqual([])
    const seqless = [...graph.targets.values()].find(target => target.kind === 'plan' && !['plan:3', 'plan:4'].includes(target.id))
    expect(seqless?.output).toEqual([{ content: 'seqless snapshot', status: 'pending' }])
    expect(graph.chatTurns[0]?.activities).toContainEqual({ kind: 'plan', targetId: 'plan:3' })
    expect(graph.trajectoryRows.filter(row => row.targetId === 'plan:3')).toHaveLength(1)
  })

  it('normalizes incomplete and malformed event tails without inventing duplicate rows', () => {
    expect(buildTraceGraph('empty', []).startTime).toBe(0)
    const graph = buildTraceGraph('edge', [
      { type: 'context/message', data: { content: [{ type: 'text', text: 'orphan context' }] } },
      { type: 'turn/end', data: { turn: 99, reason: { kind: 'error' } } },
      { type: 'context/message', data: { turn: 99, content: 'late orphan context' } },
      { type: 'turn/end', data: { turn: 99 } },
      { type: 'step/end', data: { turn: 99, step: 9 } },
      { type: 'turn/start', data: {} },
      { type: 'user/message', data: {} },
      { type: 'step/start', data: { turn: 1 } },
      { type: 'request/header-delta', data: { system: 'delta' } },
      { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'ignored stream text' } } },
      { type: 'assistant/message', data: { turn: 1, step: 0, content: [{ type: 'reasoning', text: 'fallback reasoning' }] } },
      { type: 'tool/call', data: { turn: 1, step: 0, callId: 'bad', arguments: 'not-json' } },
      { type: 'tool/result', data: { turn: 1, step: 0, callId: 'bad', isError: true, error: 'boom' } },
      { type: 'step/end', data: { turn: 1, step: 0 } },
      { type: 'tool/call', data: { turn: 1, step: 0, callId: 'raw', name: 'raw', rawInput: { value: 1 } } },
      { type: 'tool/call', data: { turn: 1, step: 0, callId: 'whole' } },
      { type: 'tool/result', data: { turn: 1, step: 0, callId: 'missing' } },
      { type: 'steering/message', data: { turn: 1, step: 0, content: [{ type: 'text', text: 'steer' }] } },
      { type: 'turn/start', seq: 20, time: 20, data: { turn: 'bad', trigger: {} } },
      { type: 'step/start', seq: 21, time: 21, data: { turn: 2, step: 1 } },
      { type: 'context/message', seq: 22, time: 22, data: { turn: 2, step: 2, content: 'context' } },
      { type: 'context/message', seq: 23, time: 23, data: { turn: 2, step: 2, content: 'context 2' } },
      { type: 'context/message', seq: 24, time: 24, data: { turn: 2, step: 1 } },
      { type: 'assistant/chunk', seq: 25, time: 25, data: { turn: 2, step: 2, chunk: { type: 'reasoning-delta', text: 'late thought' } } },
      { type: 'context/message', seq: 26, time: 26, data: { turn: 2, step: 2, content: 'return to existing group' } },
      { type: 'assistant/message', seq: 27, time: 27, data: { turn: 2, step: 2 } },
      { type: 'turn/end', seq: 28, time: 28, data: { turn: 2, reason: { kind: 'error' } } },
    ])
    expect(graph.targets.get('tool:bad')).toMatchObject({ title: 'Tool', status: 'error', input: 'not-json' })
    expect(graph.targets.get('reasoning:1:0')?.output).toBe('fallback reasoning')
    expect(graph.targets.get('context:22')?.output).toBe('context')
    expect(graph.targets.get('tool:raw')?.input).toEqual({ value: 1 })
    expect(graph.targets.get('tool:whole')?.input).toMatchObject({ callId: 'whole' })
    expect(graph.trajectoryRows.filter(row => row.targetId === 'tool:bad')).toHaveLength(1)
    expect(graph.trajectoryGroups.some(group => group.status === 'error')).toBe(true)
  })

  it('covers failure closure and inherited request inputs across later steps', () => {
    const graph = buildTraceGraph('branches', [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 3, time: 3, data: { header: { config: { model: 'm' } } } },
      { type: 'tool/call', seq: 4, time: 4, data: { turn: 1, step: 1, callId: 'fail', name: 'bash', arguments: {} } },
      { type: 'tool/result', seq: 5, time: 5, data: { turn: 1, step: 1, callId: 'fail', isError: true } },
      { type: 'step/end', seq: 6, time: 6, data: { turn: 1, step: 1 } },
      { type: 'step/start', seq: 7, time: 7, data: { turn: 1, step: 2 } },
      { type: 'assistant/message', seq: 8, time: 8, data: { turn: 1, step: 2, content: [{ type: 'reasoning', text: 'no local header' }] } },
      { type: 'step/end', seq: 9, time: 9, data: { turn: 1, step: 2 } },
      { type: 'step/start', seq: 10, time: 10, data: { turn: 1, step: 3 } },
      { type: 'assistant/message', seq: 11, time: 11, data: { turn: 1, step: 3, content: [{ type: 'text', text: 'text only' }] } },
      { type: 'steering/message', seq: 12, time: 12, data: { turn: 1, step: 3 } },
      { type: 'unknown/event', seq: 13, time: 13, data: { turn: 1, step: 3 } },
      { type: 'turn/end', seq: 14, time: 14, data: { turn: 1 } },
    ])
    expect(graph.trajectoryGroups.find(group => group.id === 'step:1:1')?.status).toBe('error')
    expect(graph.targets.get('reasoning:1:2')?.input).toEqual({ config: { model: 'm' } })
    expect(graph.targets.get('context:12')?.output).toBe('')
    expect(graph.targets.get('turn:1')?.output).toBe('')
  })
})

function fixture(): TraceEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message' } } },
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'go' }] } },
    { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 3, time: 3, data: { header: { config: { model: 'm' }, tools: [{ name: 'bash' }] } } },
    { type: 'assistant/chunk', seq: 4, time: 4, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'think ' } } },
    { type: 'assistant/chunk', seq: 5, time: 5, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'one' } } },
    { type: 'assistant/message', seq: 6, time: 6, data: { turn: 1, step: 1, content: [{ type: 'reasoning', text: 'think one' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' }] } },
    { type: 'tool/call', seq: 7, time: 7, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"pwd"}' } },
    { type: 'tool/result', seq: 8, time: 8, data: { turn: 1, step: 1, callId: 'c1', content: [{ type: 'text', text: '/repo' }], isError: false } },
    { type: 'step/end', seq: 9, time: 9, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 10, time: 10, data: { turn: 1, step: 2 } },
    { type: 'request/header', seq: 11, time: 11, data: { header: { config: { model: 'm' }, tools: [{ name: 'bash' }] } } },
    { type: 'assistant/chunk', seq: 12, time: 12, data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', text: 'think two' } } },
    { type: 'assistant/chunk', seq: 13, time: 13, data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'done' } } },
    { type: 'assistant/message', seq: 14, time: 14, data: { turn: 1, step: 2, content: [{ type: 'reasoning', text: 'think two' }, { type: 'text', text: 'done' }] } },
    { type: 'step/end', seq: 15, time: 15, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 16, time: 16, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}
