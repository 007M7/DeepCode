/**
 * Queue mirror semantics (web input-triggers queue cut 1): session/queued
 * intake, host-rule retirement (message turn/start claims oldest non-steering;
 * steering/message drains by source), leave-running sweep, reconnect reset,
 * pre-instantiation buffering, and snapshot reference stability.
 */
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { MuxFrame, RpcId, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { Session } from '../src/client/sessions/session.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient } from './fake-api.ts'
import { ev } from './event-script.ts'

const SID = 'fk-q1' as SessionId
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }]
const rid = (id: string): RpcId => id as RpcId

/** session/queued frame with the wire-sourced rpcId key (the host prompt path). */
function queuedFrame(body: string, rpcId: string, steering = false): MuxFrame {
  return {
    type: 'session/queued', sessionId: SID, content: text(body),
    source: { kind: 'user', rpcId: rid(rpcId) } as never,
    steering,
  }
}

function makeSession(): Session {
  return new Session(SID, new FakeApiClient())
}

describe('queue intake', () => {
  it('lands a queued frame as a row keyed by the source rpcId with a flat preview', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-1'), queuedFrame('第一条  排队\n消息', 'p-1'))
    const queue = session.getSnapshot().queue
    expect(queue).toEqual([{ key: 'p-1', preview: '第一条 排队 消息' }])
  })

  it('falls back to the envelope rpcId when the source carries none, and tags non-text blocks', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-2'), {
      type: 'session/queued', sessionId: SID,
      content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' } as never],
      source: { kind: 'plugin', plugin: 'loop' },
      steering: false,
    })
    expect(session.getSnapshot().queue).toEqual([{ key: 'f:env-2', preview: 'hi [image]' }])
  })

  it('caps the preview at 200 code points with an ellipsis', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-3'), queuedFrame('长'.repeat(201), 'p-cap'))
    const preview = session.getSnapshot().queue[0]?.preview ?? ''
    expect(Array.from(preview)).toHaveLength(201) // 200 + …
    expect(preview.endsWith('…')).toBe(true)
  })

  it('keeps the queue array reference stable across unrelated snapshot swaps', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('env-4'), queuedFrame('稳定', 'p-s'))
    const before = session.getSnapshot().queue
    session.handleAgentError('unrelated') // dirties the snapshot without touching the queue
    expect(session.getSnapshot().queue).toBe(before)
  })
})

describe('queue retirement (host queuedMirror rules)', () => {
  it('a message-triggered turn/start claims the oldest non-steering row', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), queuedFrame('先', 'p-1'))
    session.handleMuxEnvelope(rid('e2'), queuedFrame('后', 'p-2'))
    session.handleMuxEnvelope(rid('e3'), { type: 'session/event', sessionId: SID, event: ev.turnStart(0, 0) })
    expect(session.getSnapshot().queue.map(r => r.key)).toEqual(['p-2'])
  })

  it('an injection-triggered turn/start claims nothing', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), queuedFrame('留', 'p-1'))
    const injection = {
      ...ev.turnStart(0, 0),
      data: { turn: 0, trigger: { kind: 'injection', source: { kind: 'plugin', plugin: 'x' } } },
    } as never
    session.handleMuxEnvelope(rid('e2'), { type: 'session/event', sessionId: SID, event: injection })
    expect(session.getSnapshot().queue).toHaveLength(1)
  })

  it('steering/message drains the source-matched steering row only', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), queuedFrame('普通', 'p-1')) // idle → non-steering
    session.handleMuxEnvelope(rid('e3'), queuedFrame('插话', 'p-2', true))
    // Loop-authored steering (different source) must not consume the user entry.
    const foreignSteering = {
      seq: 0, time: 1,
      type: 'steering/message', surfaceOp: 'append',
      data: { turn: 0, content: text('loop'), source: { kind: 'plugin', plugin: 'loop' } },
    } as never
    session.handleMuxEnvelope(rid('e4'), { type: 'session/event', sessionId: SID, event: foreignSteering })
    expect(session.getSnapshot().queue).toHaveLength(2)
    const matchedSteering = {
      seq: 1, time: 2,
      type: 'steering/message', surfaceOp: 'append',
      data: { turn: 0, content: text('插话'), source: { kind: 'user', rpcId: rid('p-2') } },
    } as never
    session.handleMuxEnvelope(rid('e5'), { type: 'session/event', sessionId: SID, event: matchedSteering })
    expect(session.getSnapshot().queue.map(r => r.key)).toEqual(['p-1'])
  })

  it('a leave-running flip sweeps the whole mirror (cancel/terminal-drop cover)', () => {
    const session = makeSession()
    session.handleRunning(true)
    session.handleMuxEnvelope(rid('e1'), queuedFrame('一', 'p-1'))
    session.handleMuxEnvelope(rid('e2'), queuedFrame('二', 'p-2'))
    session.handleRunning(false)
    expect(session.getSnapshot().queue).toEqual([])
  })

  it('a stale not-running relay on an idle session still sweeps replayed rows', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), queuedFrame('孤儿', 'p-1'))
    session.handleRunning(false) // running already false: equality path must not skip the sweep
    expect(session.getSnapshot().queue).toEqual([])
  })
})

describe('queue reconnect semantics', () => {
  it('session/subscribed re-baselines the mirror: stale rows drop, the following snapshot lands fresh', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), queuedFrame('旧连接', 'p-old'))
    // New mux generation: subscribed arrives first on the same stream...
    session.handleMuxEnvelope(rid('e2'), { type: 'session/subscribed', sessionId: SID, lastSeq: 10 })
    expect(session.getSnapshot().queue).toEqual([])
    // ...then the queue snapshot replays the live inbox.
    session.handleMuxEnvelope(rid('e3'), queuedFrame('新基线', 'p-new'))
    expect(session.getSnapshot().queue.map(r => r.key)).toEqual(['p-new'])
  })

  it('resync must NOT clear the mirror (regression: onConnected races the mux baseline)', async () => {
    const session = makeSession()
    // Reconnect ordering that broke: mux opened first and already delivered
    // the fresh generation's baseline; host stream (and with it onConnected →
    // resync) lands after. The host never resends — clearing here left the
    // dock empty until the next enqueue.
    session.handleMuxEnvelope(rid('e1'), { type: 'session/subscribed', sessionId: SID, lastSeq: 5 })
    session.handleMuxEnvelope(rid('e2'), queuedFrame('新基线', 'p-fresh'))
    await session.resync()
    expect(session.getSnapshot().queue.map(r => r.key)).toEqual(['p-fresh'])
  })

  it('replayed steering retires without a replayed turn/start', () => {
    const session = makeSession()
    session.handleMuxEnvelope(rid('e1'), { type: 'session/subscribed', sessionId: SID, lastSeq: 5 })
    session.handleMuxEnvelope(rid('e2'), queuedFrame('重连插话', 'p-steer', true))
    const committed = {
      seq: 6, time: 2,
      type: 'steering/message', surfaceOp: 'append',
      data: { turn: 1, content: text('重连插话'), source: { kind: 'user', rpcId: rid('p-steer') } },
    } as never
    session.handleMuxEnvelope(rid('e3'), { type: 'session/event', sessionId: SID, event: committed })
    expect(session.getSnapshot().queue).toEqual([])
  })
})

describe('manager buffering of queued frames', () => {
  it('buffers session/queued for uninstantiated sessions and replays before the running sync', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    manager.handleMuxEnvelope({ rpcId: rid('b1'), payload: queuedFrame('预热', 'p-b1') })
    // Instantiation replays the buffer; no summary exists, so no running sweep runs.
    const session = manager.get(SID)
    expect(session.getSnapshot().queue.map(r => r.key)).toEqual(['p-b1'])
    // The buffer is consumed: a second get must not double-replay.
    expect(manager.get(SID).getSnapshot().queue).toHaveLength(1)
  })

  it('a not-running list summary sweeps replayed rows at instantiation', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok([{ sessionId: SID, updatedAt: 1, running: false }]))
    const manager = new SessionManager(api)
    await manager.refreshList()
    manager.handleMuxEnvelope({ rpcId: rid('b2'), payload: queuedFrame('该扫掉', 'p-b2') })
    expect(manager.get(SID).getSnapshot().queue).toEqual([])
  })

  it('subscribed re-baselines the uninstantiated buffer: stale queued frames drop, non-queue frames survive (regression: reconnect duplication)', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(api)
    // Generation 1 baseline lands while the session is uninstantiated, along
    // with a pending approval (never re-derivable from history).
    manager.handleMuxEnvelope({ rpcId: rid('g1a'), payload: queuedFrame('第一代', 'p-g1') })
    manager.handleMuxEnvelope({
      rpcId: rid('g1b'),
      payload: { type: 'approval/requested', sessionId: SID, approvalId: 'ap-1' as never, toolName: 'bash' },
    })
    // Reconnect: generation 2 replays subscribed + the SAME live queue entry.
    manager.handleMuxEnvelope({ rpcId: rid('g2a'), payload: { type: 'session/subscribed', sessionId: SID, lastSeq: 3 } })
    manager.handleMuxEnvelope({ rpcId: rid('g2b'), payload: queuedFrame('第一代', 'p-g1') })
    const snapshot = manager.get(SID).getSnapshot()
    // One queue row (no duplicate batch); the approval survived the re-baseline.
    expect(snapshot.queue.map(r => r.key)).toEqual(['p-g1'])
    expect(snapshot.pending.map(p => p.kind)).toEqual(['approval'])
  })
})

/** ok wrapper with a typed items payload (the shared helper pins value to never[]). */
function ok(items: { sessionId: SessionId; updatedAt: number; running: boolean }[]) {
  return { rpcId: rid(`ok-${items.length}`), result: { ok: true as const, value: { items: items as never[] } } }
}
