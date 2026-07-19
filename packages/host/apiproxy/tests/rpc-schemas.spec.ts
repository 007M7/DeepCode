import { describe, expect, it } from 'vitest'
import { RpcId } from '../src/api/rpc.ts'
import {
  clientRequestSchema, clientResponseSchema, rpcErrorSchema, rpcIdSchema, rpcMessageSchema,
  rpcReceiptSchema, rpcResultSchema, serverRequestSchema, serverResponseSchema,
} from '../src/api/rpc.schema.ts'
import { z } from 'zod'
import {
  contentBlockSchema, sessionCancelRequestSchema, sessionCancelValueSchema, sessionCreateRequestSchema,
  sessionCreateValueSchema, sessionEventSchema, sessionHistoryRequestSchema, sessionHistoryValueSchema,
  sessionIdSchema, sessionListRequestSchema, sessionListValueSchema, sessionPromptRequestSchema,
  sessionPromptValueSchema, sessionSummarySchema,
} from '../src/api/sessions.schema.ts'
import { hostDescribeRequestSchema, hostDescribeValueSchema } from '../src/api/host.schema.ts'
import { hostFrameSchema, muxFrameSchema, askUserQuestionItemSchema } from '../src/api/events.schema.ts'
import { approvalRequestIdSchema, approvalResponsePayloadSchema } from '../src/api/approvals.schema.ts'
import { askUserQuestionAnswerSchema, questionResponsePayloadSchema } from '../src/api/questions.schema.ts'

describe('RpcId', () => {
  it('brands a raw string at zero runtime cost', () => {
    expect(RpcId('abc')).toBe('abc')
    expect(rpcIdSchema.parse('abc')).toBe('abc')
    // No min-length: the id is an opaque echo token (see rpcIdSchema's contract).
    expect(rpcIdSchema.parse('')).toBe('')
    expect(() => rpcIdSchema.parse(42)).toThrow()
  })
})

describe('rpcErrorSchema', () => {
  it('accepts every code branch with its required details', () => {
    expect(rpcErrorSchema.parse({ code: 'bad-request', message: 'm', details: { issues: [] } }).code).toBe('bad-request')
    expect(rpcErrorSchema.parse({ code: 'session-not-found', message: 'm', details: { sessionId: 's' } }).code).toBe('session-not-found')
    expect(rpcErrorSchema.parse({ code: 'agent-busy', message: 'm', details: { reason: 'r' } }).code).toBe('agent-busy')
    expect(rpcErrorSchema.parse({ code: 'internal', message: 'm', details: {} }).code).toBe('internal')
  })

  it('rejects a known code with missing details', () => {
    expect(() => rpcErrorSchema.parse({ code: 'agent-busy', message: 'm', details: {} })).toThrow()
    expect(() => rpcErrorSchema.parse({ code: 'nope', message: 'm', details: {} })).toThrow()
  })
})

describe('rpcResultSchema', () => {
  it('accepts both result branches and rejects hybrids', () => {
    const schema = rpcResultSchema(z.object({ n: z.number() }))
    expect(schema.parse({ ok: true, value: { n: 1 } })).toEqual({ ok: true, value: { n: 1 } })
    const err = schema.parse({ ok: false, error: { code: 'internal', message: 'x', details: {} } })
    expect(err).toMatchObject({ ok: false })
    expect(() => schema.parse({ ok: true, error: {} })).toThrow()
  })
})

describe('wire full-form schemas', () => {
  it('parses the four quadrants and the union discriminates on type', () => {
    const cq = { type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }
    const sr = { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 1 } }
    const rq = { type: 'server-request', rpcId: 'r2', method: 'session/event', payload: { a: 1 } }
    const cr = { type: 'client-response', rpcId: 'r2', result: { ok: true, value: null } }
    expect(clientRequestSchema.parse(cq).method).toBe('session.list')
    expect(serverResponseSchema.parse(sr).rpcId).toBe('r1')
    expect(serverRequestSchema.parse(rq).method).toBe('session/event')
    expect(clientResponseSchema.parse(cr).rpcId).toBe('r2')
    for (const message of [cq, sr, rq, cr]) expect(rpcMessageSchema.parse(message)).toBeTruthy()
    expect(() => rpcMessageSchema.parse({ type: 'other', rpcId: 'x' })).toThrow()
  })

  it('rejects a quadrant missing its members', () => {
    expect(() => clientRequestSchema.parse({ type: 'client-request', rpcId: 'r1' })).toThrow()
    expect(() => serverResponseSchema.parse({ type: 'server-response', rpcId: 'r1', result: { ok: true } })).toThrow()
  })
})

describe('rpcReceiptSchema', () => {
  it('accepts both receipt branches with the closed reason set', () => {
    expect(rpcReceiptSchema.parse({ accepted: true })).toEqual({ accepted: true })
    expect(rpcReceiptSchema.parse({ accepted: false, reason: 'not-pending' })).toEqual({ accepted: false, reason: 'not-pending' })
    expect(rpcReceiptSchema.parse({ accepted: false, reason: 'bad-response' })).toEqual({ accepted: false, reason: 'bad-response' })
    expect(() => rpcReceiptSchema.parse({ accepted: false, reason: 'other' })).toThrow()
  })
})

describe('sessions domain schemas', () => {
  it('validates ids, summaries, and the event passthrough envelope', () => {
    expect(sessionIdSchema.parse('s1')).toBe('s1')
    expect(() => sessionIdSchema.parse('')).toThrow()
    expect(sessionSummarySchema.parse({ sessionId: 's1', updatedAt: 1, running: false })).toMatchObject({ sessionId: 's1' })
    expect(sessionSummarySchema.parse({ sessionId: 's1', updatedAt: 1, running: true, parentSessionId: 'p', cwd: '/x' }).cwd).toBe('/x')
    const event = sessionEventSchema.parse({ type: 'user/message', seq: 0, time: 1, data: { any: true } })
    expect(event).toMatchObject({ type: 'user/message' })
    expect(() => sessionEventSchema.parse({ type: 'user/message', seq: -1, time: 1, data: {} })).toThrow()
  })

  it('validates the per-method request/value pairs', () => {
    expect(sessionListRequestSchema.parse({})).toEqual({})
    expect(sessionListRequestSchema.parse({ cursor: 'c' }).cursor).toBe('c')
    expect(sessionListValueSchema.parse({ items: [] }).items).toEqual([])
    expect(sessionCreateRequestSchema.parse({ cwd: '/w' }).cwd).toBe('/w')
    expect(sessionCreateValueSchema.parse({ sessionId: 's1' }).sessionId).toBe('s1')
    expect(sessionHistoryRequestSchema.parse({ sessionId: 's1', beforeSeq: 3, maxMessages: 5 }).beforeSeq).toBe(3)
    expect(() => sessionHistoryRequestSchema.parse({ sessionId: 's1', maxMessages: 0 })).toThrow()
    expect(sessionHistoryValueSchema.parse({ events: [], hasMore: false }).hasMore).toBe(false)
    const prompt = sessionPromptRequestSchema.parse({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] })
    expect(prompt.mode).toBe('queue')
    expect(() => sessionPromptRequestSchema.parse({ sessionId: 's1', mode: 'inject', content: [] })).toThrow()
    expect(sessionPromptValueSchema.parse({ accepted: true }).accepted).toBe(true)
    expect(sessionCancelRequestSchema.parse({ sessionId: 's1' }).sessionId).toBe('s1')
    expect(sessionCancelValueSchema.parse({ accepted: true }).accepted).toBe(true)
    expect(contentBlockSchema.parse({ type: 'text', text: 'x', extra: 1 })).toMatchObject({ extra: 1 })
  })
})

describe('host domain schemas', () => {
  it('validates describe request/value', () => {
    expect(hostDescribeRequestSchema.parse({})).toEqual({})
    const value = hostDescribeValueSchema.parse({ version: '1', cwd: '/x', provider: 'p', model: 'm', attachedSessions: 2 })
    expect(value.attachedSessions).toBe(2)
    expect(hostDescribeValueSchema.parse({ version: '1', cwd: '/x', attachedSessions: 0 }).provider).toBeUndefined()
  })
})

describe('events frame schemas', () => {
  it('accepts every mux frame branch', () => {
    const frames = [
      { type: 'session/event', sessionId: 's', event: { type: 't', seq: 0, time: 1, data: null } },
      { type: 'session/subscribed', sessionId: 's', lastSeq: -1 },
      { type: 'approval/requested', sessionId: 's', approvalId: 'a', toolName: 'bash', callId: 'c', reason: 'r' },
      { type: 'approval/resolved', sessionId: 's', approvalId: 'a', outcome: 'allowed-once' },
      { type: 'question/requested', sessionId: 's', questions: [{ id: 'q', question: 'Q?', options: [{ label: 'L' }], multiSelect: true }] },
      { type: 'question/resolved', sessionId: 's', questionRpcId: 'r', outcome: 'answered' },
      { type: 'stream/error', error: { code: 'internal', message: 'm', details: {} } },
    ]
    for (const frame of frames) expect(muxFrameSchema.parse(frame)).toMatchObject({ type: frame.type })
    expect(() => muxFrameSchema.parse({ type: 'unknown/frame' })).toThrow()
    expect(askUserQuestionItemSchema.parse({ id: 'q', question: 'Q?' }).id).toBe('q')
  })

  it('accepts every host frame branch', () => {
    const frames = [
      { type: 'host/session-added', sessionId: 's', parentSessionId: 'p' },
      { type: 'host/session-added', sessionId: 's' },
      { type: 'host/session-removed', sessionId: 's' },
      { type: 'host/session-status', sessionId: 's', running: true },
      { type: 'host/agent-error', sessionId: 's', message: 'boom' },
      { type: 'stream/error', error: { code: 'internal', message: 'm', details: {} } },
    ]
    for (const frame of frames) expect(hostFrameSchema.parse(frame)).toMatchObject({ type: frame.type })
  })
})

describe('respond payload schemas', () => {
  it('validates approval and question answer payloads', () => {
    expect(approvalRequestIdSchema.parse('a1')).toBe('a1')
    const approval = approvalResponsePayloadSchema.parse({ sessionId: 's', approvalId: 'a', outcome: 'rejected' })
    expect(approval.outcome).toBe('rejected')
    expect(() => approvalResponsePayloadSchema.parse({ sessionId: 's', approvalId: 'a', outcome: 'cancelled' })).toThrow()
    const answer = askUserQuestionAnswerSchema.parse({ answers: [{ id: 'q', selected: ['x'], custom: 'c' }] })
    expect(answer.answers[0]?.selected).toEqual(['x'])
    const payload = questionResponsePayloadSchema.parse({ sessionId: 's', answer: { answers: [] } })
    expect(payload.sessionId).toBe('s')
  })
})
