// @vitest-environment jsdom
/**
 * Trajectory turn chrome and layout fold: expand blocks, usage on Message,
 * tool own-duration, group wall-span descriptions, in-flight rows.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { TrajectoryGroupHeader } from '../src/client/TrajectoryGroupHeader.tsx'
import { TrajectoryTurn } from '../src/client/TrajectoryTurn.tsx'
import { TrajectoryTurnHeader } from '../src/client/TrajectoryTurnHeader.tsx'
import { deriveTrajectoryLayout } from '../src/client/layout.ts'

afterEach(cleanup)

describe('TrajectoryTurnHeader', () => {
  it('renders Turn N and the four metric column labels', () => {
    render(<TrajectoryTurnHeader turn={1} />)
    expect(screen.getByText('Turn 1')).toBeTruthy()
    expect(screen.getByText('Input')).toBeTruthy()
    expect(screen.getByText('Output')).toBeTruthy()
    expect(screen.getByText('Think')).toBeTruthy()
    expect(screen.getByText('Time')).toBeTruthy()
  })
})

describe('TrajectoryGroupHeader', () => {
  it('renders title and optional description', () => {
    render(<TrajectoryGroupHeader title="Step 1" description="2.2s skill" />)
    expect(screen.getByText('Step 1')).toBeTruthy()
    expect(screen.getByText('2.2s skill')).toBeTruthy()
  })

  it('omits the description node when absent', () => {
    const { container } = render(<TrajectoryGroupHeader title="Message" />)
    expect(screen.getByText('Message')).toBeTruthy()
    expect(container.querySelectorAll('span')).toHaveLength(1)
  })
})

describe('TrajectoryTurn', () => {
  it('wraps a sticky header and body children', () => {
    render(
      <TrajectoryTurn turn={3}>
        <TrajectoryGroupHeader title="Message" description="49s" />
      </TrajectoryTurn>,
    )
    expect(screen.getByText('Turn 3')).toBeTruthy()
    expect(screen.getByText('Message')).toBeTruthy()
    expect(screen.getByText('49s')).toBeTruthy()
  })
})

describe('deriveTrajectoryLayout', () => {
  it('expands assistant blocks, hangs usage on Message, and folds call+result into Tool', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hello' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 6_000, turn: 1, step: 1,
        blocks: [
          { kind: 'reasoning', text: 'thinking…' },
          { kind: 'text', text: 'I will run bash' },
          { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{"command":"ls"}' },
        ],
        usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      },
      {
        kind: 'tool-result', seq: 3, time: 7_500, callId: 'c1',
        call: { name: 'bash', argsRaw: '{"command":"ls"}' }, callTime: 6_200,
        content: [{ type: 'text', text: 'a.txt' }], isError: false, callView: null, resultView: null,
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ codeDispatches: new Map(), nodes, partial: null, runningCalls: [] })
    expect(turns).toHaveLength(1)
    expect(turns[0]?.turn).toBe(1)
    const kinds = turns[0]?.groups.flatMap(g => g.cells.map(c => c.kind))
    expect(kinds).toEqual(['user', 'message', 'tool'])
    const message = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'message')
    expect(message).toMatchObject({
      input: 10, output: 20, think: 5, timeSeconds: 5,
    })
    const tool = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'tool')
    expect(tool?.text).toBe('bash · {"command":"ls"}')
    expect(tool?.timeSeconds).toBe(1.3)
  })

  it('adds runningCalls not already present and leaves their time blank', () => {
    const turns = deriveTrajectoryLayout({
      codeDispatches: new Map(),
      nodes: [],
      partial: null,
      runningCalls: [{
        callId: 'r1', name: 'bash', argsRaw: '{"command":"pwd"}',
        turn: 1, step: 2, time: 9_000, callView: null,
      }],
    })
    expect(turns[0]?.groups.map(g => g.title)).toEqual(['Step 2'])
    expect(turns[0]?.groups[0]?.cells[0]).toMatchObject({
      kind: 'tool', text: 'bash · {"command":"pwd"}', timeSeconds: null,
    })
  })

  it('omits duration when node times are missing instead of rendering NaN', () => {
    const nodes = [
      { kind: 'user', seq: 1, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, turn: 1, step: 1,
        blocks: [
          { kind: 'reasoning', text: '…' },
          { kind: 'text', text: 'ok' },
        ],
        usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ codeDispatches: new Map(), nodes, partial: null, runningCalls: [] })
    const cells = turns[0]?.groups.flatMap(g => g.cells) ?? []
    expect(cells.find(c => c.kind === 'message')?.timeSeconds).toBeNull()
    expect(turns[0]?.groups.find(g => g.title === 'Step 1')?.description).toBeUndefined()
  })

  it('builds a wall-span step description with a tool histogram', () => {
    const nodes = [
      {
        kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1,
        blocks: [
          { kind: 'tool-call', callId: 'a', name: 'bash', argsRaw: '{}' },
          { kind: 'tool-call', callId: 'b', name: 'bash', argsRaw: '{}' },
        ],
      },
      {
        kind: 'tool-result', seq: 2, time: 2_500, callId: 'a',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 1_100,
        content: [], isError: false, callView: null, resultView: null,
      },
      {
        kind: 'tool-result', seq: 3, time: 4_000, callId: 'b',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 2_600,
        content: [], isError: false, callView: null, resultView: null,
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ codeDispatches: new Map(), nodes, partial: null, runningCalls: [] })
    expect(turns[0]?.groups[0]?.description).toBe('2.9s bash×2')
  })

  it('assigns each user message to its enclosing turn instead of pooling into Turn 1', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'first' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 0,
        blocks: [{ kind: 'text', text: 'ok1' }],
      },
      { kind: 'user', seq: 3, time: 3_000, content: [{ type: 'text', text: 'second' }], source: null },
      {
        kind: 'assistant', seq: 4, time: 4_000, turn: 2, step: 0,
        blocks: [{ kind: 'text', text: 'ok2' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ codeDispatches: new Map(), nodes, partial: null, runningCalls: [] })
    expect(turns.map(t => t.turn)).toEqual([1, 2])
    expect(turns[0]?.groups.flatMap(g => g.cells.map(c => c.text))).toEqual(['first', 'ok1'])
    expect(turns[1]?.groups.flatMap(g => g.cells.map(c => c.text))).toEqual(['second', 'ok2'])
  })

  it('keeps usage on the fallback Message row when assistant has no text block', () => {
    const nodes = [
      {
        kind: 'assistant', seq: 1, time: 5_000, turn: 1, step: 0,
        blocks: [{ kind: 'reasoning', text: '…' }],
        usage: { inputTokens: 11, outputTokens: 22, reasoningTokens: 3 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ codeDispatches: new Map(), nodes, partial: null, runningCalls: [] })
    const message = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'message')
    expect(message).toMatchObject({
      text: '', input: 11, output: 22, think: 3,
    })
  })

  it('advances the duration cursor over context nodes', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}' }],
      },
      {
        kind: 'tool-result', seq: 3, time: 3_000, callId: 'c1',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 2_100,
        content: [], isError: false, callView: null, resultView: null,
      },
      {
        kind: 'context', seq: 4, time: 9_000,
        content: [{ type: 'text', text: 'extra' }], source: null,
      },
      {
        kind: 'assistant', seq: 5, time: 10_000, turn: 1, step: 0,
        blocks: [{ kind: 'text', text: 'done' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ codeDispatches: new Map(), nodes, partial: null, runningCalls: [] })
    const message = turns[0]?.groups
      .flatMap(g => g.cells)
      .find(c => c.kind === 'message' && c.text === 'done')
    // From context at 9s, not from the earlier user/tool surfaces.
    expect(message?.timeSeconds).toBe(1)
  })
})

describe('run_code sub-dispatch cells', () => {
  const runCodeNodes = [
    {
      kind: 'assistant', seq: 2, time: 6_000, turn: 1, step: 1,
      blocks: [
        { kind: 'tool-call', callId: 'p1', name: 'run_code', argsRaw: '{"code":"…","description":"批量读取"}' },
      ],
    },
    {
      kind: 'tool-result', seq: 3, time: 9_000, callId: 'p1',
      call: { name: 'run_code', argsRaw: '{"code":"…","description":"批量读取"}' }, callTime: 6_200,
      content: [{ type: 'text', text: 'done' }], isError: false, callView: null, resultView: null,
    },
  ] as unknown as ConversationSnapshot['nodes']

  const settledSub = (n: number, name: string, start: number, end: number) => ({
    kind: 'tool-result' as const, seq: 100 + n, time: end,
    callId: `p1:code:${n}`,
    call: { name, argsRaw: '{"x":1}' }, callTime: start,
    content: [{ type: 'text' as const, text: 'ok' }], isError: false, callView: null, resultView: null,
  })

  it('nests settled sub-cells after their parent Tool cell with real durations', () => {
    const codeDispatches = new Map([['p1', [
      settledSub(1, 'bash', 6_300, 7_300),
      settledSub(2, 'read', 7_300, 7_800),
    ]]]) as unknown as ConversationSnapshot['codeDispatches']
    const turns = deriveTrajectoryLayout({ codeDispatches, nodes: runCodeNodes, partial: null, runningCalls: [] })
    const cells = turns[0]!.groups.flatMap(g => g.cells)
    expect(cells.map(c => c.kind)).toEqual(['tool', 'subtool', 'subtool'])
    // Sequential indexes across the interleave; durations from the pair times.
    expect(cells.map(c => c.index)).toEqual([1, 2, 3])
    expect(cells[1]).toMatchObject({ text: 'bash · {"x":1}', timeSeconds: 1 })
    expect(cells[2]).toMatchObject({ timeSeconds: 0.5 })
  })

  it('a running (unsettled) sub-call renders a subtool cell with blank time', () => {
    const running = {
      callId: 'p1:code:1', name: 'grep', argsRaw: '{"pattern":"x"}',
      turn: 0, step: 0, time: 6_400, callView: null,
    }
    const codeDispatches = new Map([['p1', [running]]]) as unknown as ConversationSnapshot['codeDispatches']
    const turns = deriveTrajectoryLayout({ codeDispatches, nodes: runCodeNodes, partial: null, runningCalls: [] })
    const sub = turns[0]!.groups.flatMap(g => g.cells).find(c => c.kind === 'subtool')
    expect(sub).toMatchObject({ text: 'grep · {"pattern":"x"}', timeSeconds: null })
  })
})
