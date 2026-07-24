import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  buildSessionEventRecords,
  buildSessionEventSearchDocuments,
  compileSessionTextFilter,
  extractSessionEventText,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
  type SessionQueryErrorCode,
} from '@deepseek-ai/dsh-session-query'
import { TestSessionQueryService } from './test-service.ts'

const id = SessionId('session')

function header(value: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(value), createdAt: 10, ...extra }
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

describe('session-query semantic extraction', () => {
  it('extracts first-party message, tool, todo, and failure detail', () => {
    const callId = CallId('call')
    const messageContent: SessionEvent<'user/message'>['data']['content'] = [
      { type: 'text', text: ' visible ' },
      { type: 'reasoning', text: 'thought' },
      { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a"}' },
      {
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'nested' }],
        isError: false,
      },
      { type: 'future-content', payload: 'hidden' } as never,
    ]
    const events: SessionEvent[] = [
      { type: 'user/message', seq: 0, time: 1, data: { content: messageContent, source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, content: messageContent, provenance: { provider: 'mock', model: 'mock' } }, surfaceOp: 'append' },
      { type: 'user/message', seq: 2, time: 3, data: { content: messageContent, source: { kind: 'plugin', plugin: 'test' } }, surfaceOp: 'append' },
      { type: 'steering/message', seq: 3, time: 4, data: { turn: 1, content: messageContent, source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'prompt/blocked', seq: 4, time: 5, data: { content: [{ type: 'text', text: 'unsafe' }], source: { kind: 'user' }, reason: 'policy' } },
      { type: 'tool/call', seq: 5, time: 6, data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{"cmd":"pwd"}' } },
      { type: 'tool/result', seq: 6, time: 7, data: { turn: 1, step: 1, callId, content: [{ type: 'text', text: 'failed' }], isError: true, error: { name: 'Oops', code: 'E_OOPS' } }, surfaceOp: 'append' },
      { type: 'tool/result', seq: 7, time: 8, data: { turn: 1, step: 1, callId, content: [], isError: false }, surfaceOp: 'append' },
      { type: 'todo/write', seq: 8, time: 9, data: { todos: [{ status: 'in_progress', content: 'ship search' }] } },
    ]

    for (const event of events.slice(0, 4)) {
      expect(extractSessionEventText(event)).toBe('visible\nthought\nread\n{"path":"a"}\nnested')
    }
    expect(extractSessionEventText(events[4]!)).toBe('unsafe\npolicy')
    expect(extractSessionEventText(events[5]!)).toBe('bash\n{"cmd":"pwd"}')
    expect(extractSessionEventText(events[6]!)).toBe('failed\nOops\nE_OOPS')
    expect(extractSessionEventText(events[7]!)).toBe('')
    expect(extractSessionEventText(events[8]!)).toBe('in_progress\nship search')
  })

  it('extracts meaningful turn outcomes and skips structural or unknown events', () => {
    const reasons: Array<[SessionEvent<'turn/end'>['data']['reason'], string]> = [
      [{ kind: 'error', step: 2, message: 'boom', code: 'E' }, 'error\nboom\nE'],
      [{ kind: 'error', step: 2, message: 'boom' }, 'error\nboom'],
      [{ kind: 'error', step: 2, failure: { message: 'provider boom', code: 'SERVER' } }, 'error\nprovider boom\nSERVER'],
      [{ kind: 'aborted' }, 'aborted'],
      [{ kind: 'rejected', reason: 'denied' }, 'rejected\ndenied'],
      [{ kind: 'disposed' }, 'disposed'],
      [{ kind: 'max-tokens' }, 'max-tokens'],
      [{ kind: 'interrupted' }, 'interrupted'],
      [{ kind: 'completed' }, ''],
      [{ kind: 'future-status' } as never, ''],
    ]
    for (const [reason, text] of reasons) {
      expect(extractSessionEventText({ type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason } })).toBe(text)
    }
    const structural: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, time: 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 3, time: 1, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'raw' } } },
      { type: 'request/header', seq: 4, time: 1, data: { header: { config: { provider: 'test', model: 'test' } }, reason: 'initial' } },
      { type: 'future/event', seq: 5, time: 1, data: { text: 'hidden' } } as never,
    ]
    expect(structural.map(extractSessionEventText)).toEqual(['', '', '', '', '', ''])
  })
})

describe('session-query document and filter helpers', () => {
  const events: SessionEvent[] = [
    { type: 'user/message', seq: 0, time: 10, data: { content: [{ type: 'text', text: 'Hello\n(AI)+' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/chunk', seq: 1, time: 11, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'raw' } } },
    { type: 'assistant/message', seq: 2, time: 12, data: { turn: 1, step: 1, content: [{ type: 'text', text: 'replacement' }], provenance: { provider: 'mock', model: 'mock' } }, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] },
    { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]

  it('classifies every event and omits non-semantic documents', () => {
    expect(buildSessionEventRecords(id, events).map(record => record.surface))
      .toEqual(['shadowed', 'log-only', 'current', 'log-only'])
    const documents = buildSessionEventSearchDocuments(id, events)
    expect(documents.map(document => [document.seq, document.text, document.surface])).toEqual([
      [0, 'Hello\n(AI)+', 'shadowed'],
      [2, 'replacement', 'current'],
      [3, 'interrupted', 'log-only'],
    ])
  })

  it('applies every session clause with OR values and validates closed values', () => {
    const parent = SessionId('parent')
    const records = [
      { header: header('a', { cwd: '/a', parentSession: parent }), live: true, persisted: false, marker: 1 },
      { header: header('b', { createdAt: 20 }), live: false, persisted: true, marker: 2 },
    ]
    expect(filterSessionResults(records, [
      { kind: 'id', values: [SessionId('a'), SessionId('x')] },
      { kind: 'cwd', values: ['/a', null] },
      { kind: 'created-at', from: 5, to: 15 },
      { kind: 'parent', values: [parent, null] },
      { kind: 'availability', values: ['live'] },
    ])).toEqual([records[0]])
    expect(filterSessionResults(records, [{ kind: 'cwd', values: [null] }])).toEqual([records[1]])
    expect(filterSessionResults(records, [{ kind: 'parent', values: [null] }])).toEqual([records[1]])
    expect(filterSessionResults(records, [{ kind: 'availability', values: ['persisted'] }])).toEqual([records[1]])
    expect(() => filterSessionResults(records, [{ kind: 'availability', values: ['remote' as never] }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('applies event metadata and safe literal text clauses', () => {
    const documents = buildSessionEventSearchDocuments(id, events).map((document, marker) => ({ ...document, marker }))
    expect(filterSessionEventDocuments(documents, [
      { kind: 'seq', from: 0, to: 1 },
      { kind: 'time', from: 9, to: 11 },
      { kind: 'type', values: ['user/message', 'tool/result'] },
      { kind: 'surface', values: ['shadowed'] },
      { kind: 'text', text: 'hello   (ai)+' },
    ])).toEqual([documents[0]])
    expect(compileSessionTextFilter('CAFÉ').test('café')).toBe(true)
    expect(filterSessionEventDocuments(documents)).toEqual(documents)
    expect(filterSessionEventDocuments(documents, [{ kind: 'surface', values: [] }])).toEqual([])
    expect(() => filterSessionEventDocuments(documents, [{ kind: 'surface', values: ['future' as never] }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => compileSessionTextFilter(' \n ')).toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('rejects malformed range filters and malformed surfaces', () => {
    const documents = buildSessionEventSearchDocuments(id, events)
    for (const filter of [
      { kind: 'seq', from: Number.NaN },
      { kind: 'seq', to: Number.POSITIVE_INFINITY },
      { kind: 'time', from: 2, to: 1 },
    ] as const) {
      expect(() => filterSessionEventDocuments(documents, [filter]))
        .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    }
    expect(() => filterSessionResults([], [{ kind: 'created-at', from: Number.NaN }]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => filterSessionResults([{ header: header('x'), live: true, persisted: false }], [
      { kind: 'created-at', from: Number.NaN },
    ])).toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    const malformed: SessionEvent[] = [{
      type: 'assistant/message',
      seq: 0,
      time: 1,
      data: { turn: 1, step: 1, content: [{ type: 'text', text: 'bad' }], provenance: { provider: 'mock', model: 'mock' } },
      surfaceOp: { op: 'replace', start: 9, end: 9 },
    }]
    expect(() => buildSessionEventRecords(id, malformed)).toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))
  })

  it('owns filters and rejects malformed runtime filter shapes deterministically', () => {
    expect(materializeSessionResultFilters([{ kind: 'created-at', to: 2 }]))
      .toEqual([{ kind: 'created-at', to: 2 }])
    expect(() => materializeSessionResultFilters('not-an-array' as never))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => materializeSessionResultFilters([{ kind: 'id', values: 'bad' } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => materializeSessionResultFilters([{ kind: 'id', values: [1] } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => materializeSessionResultFilters([{ kind: 'cwd', values: 'bad' } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => materializeSessionResultFilters([{ kind: 'parent', values: [1] } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => materializeSessionResultFilters([{} as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => materializeSessionEventResultFilters([{ kind: 'text', text: 1 } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => materializeSessionEventResultFilters([{ kind: 'future' } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => filterSessionResults([], [{ kind: 'future' } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => filterSessionEventDocuments([], [{ kind: 'future' } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('exposes the scan path on the combined query service', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(TestSessionQueryService)
    const session = ctx.sessions.create(id)
    session.append('user/message', { content: [{ type: 'text', text: 'Alpha\n beta' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    session.append('user/message', { content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    await expect(ctx.sessionQuery.filterEvents(id, [{ kind: 'text', text: 'alpha beta' }]))
      .resolves.toMatchObject([{ seq: 0, text: 'Alpha\n beta' }])
  })
})

it('registers exact and abstract search behavior under one ctx key', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(TestSessionQueryService)
  await expect(ctx.sessionQuery.searchSessions({ query: 'AI' })).resolves.toEqual({ items: [] })
  await expect(ctx.sessionQuery.searchEvents({ sessionId: id, query: 'AI' })).resolves.toEqual({ items: [] })
  await fiber.dispose()
  expect(ctx.sessionQuery).toBeUndefined()
})
