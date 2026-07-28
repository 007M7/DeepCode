import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { inspectRequests } from '../src/client/sessions/request-inspection.ts'

const at = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, type, data }) as SessionEvent

const entriesOf = (events: readonly SessionEvent[]): HistoryEntry[] =>
  events.map(event => ({ event }))

describe('inspectRequests', () => {
  it('projects ordinary and compaction calls into one chronological request stream', () => {
    const events = [
      at(0, 'step/start', { turn: 1, step: 1 }),
      at(1, 'request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'fake', model: 'model' },
          system: 'system',
          tools: [{
            name: 'read',
            description: 'Read a file.',
            parameters: { type: 'object' },
          }],
        },
      }),
      at(2, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'read',
        arguments: '{}',
      }),
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        content: [{ type: 'text', text: 'done' }],
        provenance: { provider: 'fake', model: 'model' },
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
      at(4, 'step/end', { turn: 1, step: 1 }),
      at(5, 'compact/start', { turn: 1 }),
      at(6, 'compact/summary', {
        summary: [{ type: 'text', text: 'summary' }],
        rawOutput: [
          { type: 'reasoning', text: 'thought' },
          { type: 'text', text: 'summary' },
        ],
        provider: 'fake',
        model: 'compact-model',
        usage: { inputTokens: 8, outputTokens: 3 },
      }),
      at(7, 'user/message', {
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact' },
      }),
      at(8, 'compact/end', { turn: 1 }),
    ]
    const snapshot = inspectRequests(entriesOf(events))
    expect(snapshot.requests).toMatchObject([
      {
        purpose: 'assistant',
        startSeq: 0,
        resultSeq: 3,
        status: 'complete',
        prompt: {
          config: { provider: 'fake', model: 'model' },
          system: 'system',
        },
        promptChange: { seq: 1, kind: 'initial' },
      },
      {
        purpose: 'compaction',
        startSeq: 5,
        resultSeq: 6,
        replacementSeq: 7,
        status: 'complete',
        summary: [{ type: 'text', text: 'summary' }],
      },
    ])
    expect(snapshot.callSchemas.get('call-1')?.name).toBe('read')
  })

  it('captures schemas for nested tool dispatches from the active request header', () => {
    const snapshot = inspectRequests(entriesOf([
      at(0, 'request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'fake', model: 'model' },
          tools: [{
            name: 'read',
            description: 'Read a file.',
            parameters: { type: 'object' },
          }],
        },
      }),
      at(1, 'tool/code-dispatch-start', {
        parentCallId: 'parent',
        subCallId: 'nested',
        name: 'read',
        arguments: {},
      }),
    ]))

    expect(snapshot.callSchemas.get('nested')?.name).toBe('read')
  })
})
