import { describe, expect, it } from 'vitest'
import type {
  ConversationContext, ConversationNode, RequestView,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  deriveTrajectoryContextBranches,
  trajectoryBranchContainsRequest,
} from '../src/client/context-branches.ts'

const checkpoint = {
  kind: 'context',
  seq: 100,
  time: 100,
  content: [],
  source: { kind: 'plugin', plugin: 'compact' },
  provenance: { role: 'inject', label: 'compact' },
  form: null,
} as ConversationNode

const abandoned = {
  kind: 'assistant',
  seq: 20,
  time: 20,
  turn: 1,
  step: 1,
  blocks: [{ kind: 'text', text: 'abandoned' }],
} as ConversationNode

const current = {
  kind: 'user',
  seq: 110,
  time: 110,
  content: [{ type: 'text', text: 'rewound' }],
  source: { kind: 'plugin', plugin: 'rewind' },
} as ConversationNode

function interruptedTool(callId: string): ConversationNode {
  return {
    kind: 'tool-result',
    seq: 19.2,
    time: 20,
    callId,
    call: { name: 'parallel', argsRaw: '{}' },
    callTime: 10,
    content: [],
    isError: true,
    error: { name: 'Interrupted', code: 'interrupted' },
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

function request(
  purpose: RequestView['purpose'],
  startSeq: number,
  resultSeq?: number,
  replacementSeq?: number,
): RequestView {
  const base = {
    startSeq,
    startedAt: startSeq,
    completedAt: startSeq + 1,
    status: 'complete' as const,
    ...(resultSeq === undefined ? {} : { resultSeq }),
  }
  return purpose === 'assistant'
    ? { ...base, purpose, turn: 1, step: 1 }
    : {
      ...base,
      purpose,
      turn: 1,
      step: 0,
      ...(replacementSeq === undefined ? {} : { replacementSeq }),
    }
}

describe('trajectory context branches', () => {
  it('inherits nodes and requests by retained surface position rather than seq cutoff', () => {
    const contexts: ConversationContext[] = [
      { id: 0, nodes: [checkpoint, abandoned] },
      {
        id: 1,
        parentId: 0,
        origin: 'rewind',
        originSeq: 110,
        nodes: [checkpoint, current],
      },
    ]
    const branches = deriveTrajectoryContextBranches(contexts)
    const successor = branches[1]!

    expect(successor.key).toBe('rewind:110')
    expect(successor.nodes.map(node => node.seq)).toEqual([110])
    expect(trajectoryBranchContainsRequest(
      successor,
      request('assistant', 10, 20),
    )).toBe(false)
    expect(trajectoryBranchContainsRequest(
      successor,
      request('compaction', 90, 95, 100),
    )).toBe(true)
    expect(trajectoryBranchContainsRequest(
      successor,
      request('assistant', 111),
    )).toBe(true)
  })

  it('keeps branch identity when prepended generations shift local ids', () => {
    const branch = (id: number) => deriveTrajectoryContextBranches([{
      id,
      origin: 'rewind',
      originSeq: 110,
      nodes: [current],
    }])[0]

    expect(branch(1)?.key).toBe(branch(9)?.key)
  })

  it('retains parallel tool interruptions that share one closing boundary', () => {
    const branch = deriveTrajectoryContextBranches([{
      id: 0,
      nodes: [interruptedTool('call-a'), interruptedTool('call-b')],
    }])[0]

    expect(branch?.nodes.map(node => node.kind === 'tool-result' ? node.callId : undefined))
      .toEqual(['call-a', 'call-b'])
  })
})
