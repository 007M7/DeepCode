import { describe, expect, it } from 'vitest'
import type { RequestView } from '@deepseek-ai/dsh-client-runtime/client'
import type { TrajectoryConversationViewNode } from '../src/client/trajectory-contract.ts'
import { TrajectorySnapshotBuilder } from '../src/client/trajectory-snapshot-builder.ts'

function assistantRequest(startSeq: number, step: number): Extract<RequestView, { purpose: 'assistant' }> {
  return {
    purpose: 'assistant',
    startSeq,
    turn: 1,
    step,
    startedAt: startSeq,
    completedAt: startSeq + 1,
    status: 'complete',
  }
}

describe('TrajectorySnapshotBuilder', () => {
  it('inherits one request header across requests without repeating its prompt change', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'one initial prompt',
      tools: [],
    }
    const nodes: TrajectoryConversationViewNode[] = [
      {
        key: 'header',
        kind: 'trajectory-request-header',
        id: '2',
        target: 'trajectory',
        anchorSeq: 2,
        data: {
          kind: 'request-header',
          header: {
            seq: 2,
            time: 2,
            prompt,
            change: { seq: 2, time: 2, kind: 'initial' },
            location: { kind: 'session' },
          },
        },
      },
      ...[assistantRequest(3, 1), assistantRequest(5, 2)].map(request => ({
        key: `assistant:${request.step}`,
        kind: 'trajectory-assistant-step',
        id: `1:${request.step}`,
        target: 'trajectory' as const,
        anchorSeq: request.startSeq,
        data: { kind: 'assistant' as const, partial: null, request },
      })),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['one initial prompt', 'one initial prompt'])
    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.kind
      : undefined)).toEqual(['initial', undefined])
  })
})
