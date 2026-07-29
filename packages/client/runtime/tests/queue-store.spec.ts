/**
 * Queue snapshot semantics: authoritative replacement after every host-side
 * change, reconnect re-baselining, pre-instantiation buffering, editable-text
 * projection, and snapshot reference stability.
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type {
  InboxItemId, MuxFrame, RpcId, SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import { Session } from '../src/client/sessions/session.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient } from './fake-api.ts'

const SID = 'fk-q1' as SessionId
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const rid = (id: string): RpcId => id as RpcId
const iid = (id: string): InboxItemId => id as InboxItemId

interface QueueFixture {
  id: string
  body: string
  content?: ContentBlock[]
}

/** Build one authoritative queue snapshot. */
function queueFrame(items: QueueFixture[]): MuxFrame {
  return {
    type: 'session/queue',
    sessionId: SID,
    items: items.map(item => ({
      id: iid(item.id),
      message: createUserMessage({
        content: item.content ?? text(item.body),
        source: { kind: 'user', rpcId: rid(`rpc-${item.id}`) } as never,
      }),
    })),
  }
}

function makeSession(): Session {
  return new Session(SID, new FakeApiClient())
}

describe('queue snapshot intake', () => {
  it('projects stable ids, flat previews, and complete text', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-1'), queueFrame([
      { id: 'q-1', body: '第一条  排队\n消息' },
    ]))
    expect(session.getSnapshot().queue).toEqual([
      { id: 'q-1', preview: '第一条 排队 消息', text: '第一条  排队\n消息' },
    ])
  })

  it('marks mixed-content messages non-editable while retaining their preview', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-2'), queueFrame([{
      id: 'q-image',
      body: '',
      content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' } as never],
    }]))
    expect(session.getSnapshot().queue).toEqual([
      { id: 'q-image', preview: 'hi [image]', text: null },
    ])
  })

  it('caps previews at 200 code points and preserves the full editable text', () => {
    const session = makeSession()
    const body = '长'.repeat(201)
    session.handleMuxEnvelope(rid('env-3'), queueFrame([{ id: 'q-cap', body }]))
    const row = session.getSnapshot().queue[0]
    expect(Array.from(row?.preview ?? '')).toHaveLength(201)
    expect(row?.preview.endsWith('…')).toBe(true)
    expect(row?.text).toBe(body)
  })

  it('replaces content, order, and membership from each authoritative frame', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-4'), queueFrame([
      { id: 'q-1', body: 'one' },
      { id: 'q-2', body: 'two' },
    ]))
    session.handleMuxEnvelope(rid('env-5'), queueFrame([
      { id: 'q-2', body: 'two edited' },
    ]))
    expect(session.getSnapshot().queue).toEqual([
      { id: 'q-2', preview: 'two edited', text: 'two edited' },
    ])
    session.handleMuxEnvelope(rid('env-6'), queueFrame([]))
    expect(session.getSnapshot().queue).toEqual([])
  })

  it('keeps the queue array reference stable across unrelated snapshot swaps', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-7'), queueFrame([{ id: 'q-stable', body: '稳定' }]))
    const before = session.getSnapshot().queue
    session.handleAgentError('unrelated')
    expect(session.getSnapshot().queue).toBe(before)
  })
})

describe('queue operation transport', () => {
  it('addresses the session.updateQueue RPC without optimistic local mutation', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api)
    session.handleMuxEnvelope(rid('env-op'), queueFrame([{ id: 'q-op', body: 'pending' }]))
    const before = session.getSnapshot().queue

    await expect(session.updateQueue(iid('q-op'), { kind: 'edit', content: text('next') }))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(api.callsOf('session.updateQueue')).toEqual([{
      sessionId: SID,
      itemId: 'q-op',
      action: { kind: 'edit', content: text('next') },
    }])
    expect(session.getSnapshot().queue).toBe(before)
  })
})

describe('queue reconnect semantics', () => {
  it('session/subscribed clears stale state before the fresh snapshot lands', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), queueFrame([{ id: 'q-old', body: '旧连接' }]))
    session.handleMuxEnvelope(rid('e2'), { type: 'session/subscribed', sessionId: SID, lastSeq: 10 })
    expect(session.getSnapshot().queue).toEqual([])
    session.handleMuxEnvelope(rid('e3'), queueFrame([{ id: 'q-new', body: '新基线' }]))
    expect(session.getSnapshot().queue.map(row => row.id)).toEqual(['q-new'])
  })

  it('resync does not clear a baseline that raced ahead of the host connection signal', async () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), { type: 'session/subscribed', sessionId: SID, lastSeq: 5 })
    session.handleMuxEnvelope(rid('e2'), queueFrame([{ id: 'q-fresh', body: '新基线' }]))
    await session.resync()
    expect(session.getSnapshot().queue.map(row => row.id)).toEqual(['q-fresh'])
  })

  it('running-status changes never guess at queue retirement', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), queueFrame([{ id: 'q-live', body: '保留' }]))
    session.handleRunning(true)
    session.handleRunning(false)
    expect(session.getSnapshot().queue.map(row => row.id)).toEqual(['q-live'])
  })
})

describe('manager buffering of queue snapshots', () => {
  it('replays only the latest snapshot for an uninstantiated session', () => {
    const manager = new SessionManager(new FakeApiClient())
    manager.handleMuxEnvelope({ rpcId: rid('b1'), payload: queueFrame([{ id: 'q-old', body: '旧' }]) })
    manager.handleMuxEnvelope({ rpcId: rid('b2'), payload: queueFrame([{ id: 'q-new', body: '新' }]) })
    expect(manager.get(SID).getSnapshot().queue.map(row => row.id)).toEqual(['q-new'])
  })

  it('subscribed drops the prior-generation snapshot while preserving answerable frames', () => {
    const manager = new SessionManager(new FakeApiClient())
    manager.handleMuxEnvelope({ rpcId: rid('g1a'), payload: queueFrame([{ id: 'q-g1', body: '第一代' }]) })
    manager.handleMuxEnvelope({
      rpcId: rid('g1b'),
      payload: { type: 'approval/requested', sessionId: SID, approvalId: 'ap-1' as never, toolName: 'bash' },
    })
    manager.handleMuxEnvelope({
      rpcId: rid('g2a'),
      payload: { type: 'session/subscribed', sessionId: SID, lastSeq: 3 },
    })
    manager.handleMuxEnvelope({ rpcId: rid('g2b'), payload: queueFrame([{ id: 'q-g2', body: '第二代' }]) })
    const snapshot = manager.get(SID).getSnapshot()
    expect(snapshot.queue.map(row => row.id)).toEqual(['q-g2'])
    expect(snapshot.pending.map(pending => pending.kind)).toEqual(['approval'])
  })
})
