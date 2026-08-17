import { describe, expect, it } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { deriveFlowRows, type FlowRow } from '../src/client/chat/tool-call-grouping.ts'

function toolNode(key: string, root: RunningToolCall | ToolResultNode): ChatNode<'tool-call'> {
  return {
    key: `fixture:tool:${key}`,
    id: key,
    target: 'chat',
    kind: 'tool-call',
    anchorSeq: 1,
    location: { kind: 'session' },
    visibility: 'visible',
    data: { root },
  }
}

function settled(key: string, name: string): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 1_000,
    callId: key,
    call: { name, argsRaw: '{}' },
    callTime: 1_000,
    content: [],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

function running(key: string, name: string): RunningToolCall {
  return {
    callId: key,
    name,
    argsRaw: '{}',
    turn: 1,
    step: 1,
    time: 1_000,
    callView: null,
    subCalls: [],
  }
}

function keysOf(rows: readonly FlowRow[]): string[] {
  return rows.map(row => row.kind === 'node' ? `node:${row.key}` : `group:${row.toolName}:${row.memberKeys.join(',')}`)
}

function store(nodes: readonly ChatNode[]): (key: string) => ChatNode | undefined {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  return key => byKey.get(key)
}

describe('deriveFlowRows', () => {
  it('keeps a single settled tool call as an ordinary row', () => {
    const node = toolNode('a', settled('a', 'read'))
    expect(deriveFlowRows(['fixture:tool:a'], store([node]))).toEqual([{ kind: 'node', key: 'fixture:tool:a' }])
  })

  it('merges two consecutive same-name settled calls into one group', () => {
    const a = toolNode('a', settled('a', 'read'))
    const b = toolNode('b', settled('b', 'read'))
    expect(deriveFlowRows(['fixture:tool:a', 'fixture:tool:b'], store([a, b]))).toEqual([{
      kind: 'tool-group',
      key: 'fixture:tool:a',
      toolName: 'read',
      memberKeys: ['fixture:tool:a', 'fixture:tool:b'],
    }])
  })

  it('breaks the run on a different tool name', () => {
    const a = toolNode('a', settled('a', 'read'))
    const b = toolNode('b', settled('b', 'grep'))
    const c = toolNode('c', settled('c', 'read'))
    const rows = deriveFlowRows(
      ['fixture:tool:a', 'fixture:tool:b', 'fixture:tool:c'],
      store([a, b, c]),
    )
    expect(keysOf(rows)).toEqual([
      'node:fixture:tool:a',
      'node:fixture:tool:b',
      'node:fixture:tool:c',
    ])
  })

  it('breaks the run on a non-tool node between same-name calls', () => {
    const a = toolNode('a', settled('a', 'read'))
    const c = toolNode('c', settled('c', 'read'))
    const assistant = {
      key: 'fixture:assistant:2',
      id: '2',
      target: 'chat',
      kind: 'assistant-step',
      anchorSeq: 2,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { status: 'settled', turn: 1, step: 1, blocks: [], time: 1, finalNode: {} },
    } as ChatNode
    const rows = deriveFlowRows(
      ['fixture:tool:a', 'fixture:assistant:2', 'fixture:tool:c'],
      store([a, assistant, c]),
    )
    expect(keysOf(rows)).toEqual(['node:fixture:tool:a', 'node:fixture:assistant:2', 'node:fixture:tool:c'])
  })

  it('never merges running calls, even between settled same-name calls', () => {
    const a = toolNode('a', settled('a', 'read'))
    const mid = toolNode('m', running('m', 'read'))
    const c = toolNode('c', settled('c', 'read'))
    const rows = deriveFlowRows(
      ['fixture:tool:a', 'fixture:tool:m', 'fixture:tool:c'],
      store([a, mid, c]),
    )
    expect(keysOf(rows)).toEqual(['node:fixture:tool:a', 'node:fixture:tool:m', 'node:fixture:tool:c'])
  })

  it('keeps a windowless settled call (no call head) as an ordinary row', () => {
    const node = toolNode('w1', { ...settled('w1', 'read'), call: null })
    expect(deriveFlowRows(['fixture:tool:w1'], store([node]))).toEqual([{ kind: 'node', key: 'fixture:tool:w1' }])
  })

  it('merges longer runs and adjacent runs of different tools independently', () => {
    const reads = ['a', 'b', 'c'].map(key => toolNode(key, settled(key, 'read')))
    const greps = ['d', 'e'].map(key => toolNode(key, settled(key, 'grep')))
    const single = toolNode('f', settled('f', 'read'))
    const rows = deriveFlowRows(
      ['fixture:tool:a', 'fixture:tool:b', 'fixture:tool:c', 'fixture:tool:d', 'fixture:tool:e', 'fixture:tool:f'],
      store([...reads, ...greps, single]),
    )
    expect(keysOf(rows)).toEqual([
      'group:read:fixture:tool:a,fixture:tool:b,fixture:tool:c',
      'group:grep:fixture:tool:d,fixture:tool:e',
      'node:fixture:tool:f',
    ])
  })
})
