/**
 * Fixture impl semantics: the demo data source must honor the same contract
 * shapes as the real host (paging boundaries, rpcId echo, replay lifecycle,
 * baseline replay, timing hooks) — this is the vitest-side drift detector for
 * the hand-written fixture/host parallel implementations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import type { HostFrame, MuxFrame, RpcMessage, RpcRequest } from '../src/client/api.ts'
import { FixtureApiClient, createFixtureApi } from '../src/client/fixture.ts'

const sid = (id: string): SessionId => id as SessionId
const req = <P>(payload: P): RpcRequest<P> => ({ rpcId: RpcId(`t-${Math.abs(Math.sin(reqCount++)).toString(36).slice(2, 10)}`), payload })
let reqCount = 0

interface TimingHooks {
  setHistoryDelay(ms: number): void
  failNextHistory(): void
  appendUser(id: string, msg: string): void
  appendSilent(id: string, msg: string): void
  breakStreams(): void
}
const timing = (): TimingHooks => (globalThis as Record<string, unknown>).__fxTiming as TimingHooks

/** Collect stream frames until the predicate or a soft cap; abort ends the stream. */
async function collect<F>(stream: AsyncIterable<RpcRequest<F>>, abort: AbortController, done: (frames: F[]) => boolean): Promise<F[]> {
  const frames: F[] = []
  for await (const envelope of stream) {
    frames.push(envelope.payload)
    if (done(frames) || frames.length > 500) {
      abort.abort()
      break
    }
  }
  return frames
}

describe('createFixtureApi', () => {
  it('serves the session list sorted by updatedAt desc and echoes rpcIds on every unary', async () => {
    const api = createFixtureApi()
    const request = req({})
    const response = await api.sessions.list(request)
    expect(response.rpcId).toBe(request.rpcId)
    if (!response.result.ok) throw new Error('list failed')
    expect(response.result.value.items.map(s => s.sessionId)).toEqual(['fx-alpha', 'fx-beta', 'fx-gamma'])
    expect(response.result.value.items[1]?.parentSessionId).toBe('fx-alpha') // lineage material
  })

  it('pages history backwards on message-boundary cuts with seq-contiguous stitching', async () => {
    const api = createFixtureApi()
    const tail = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 10 }))
    if (!tail.result.ok) throw new Error('history failed')
    const tailPage = tail.result.value
    expect(tailPage.hasMore).toBe(true)
    expect(tailPage.events[0]?.event.type).toBe('turn/start') // cut lands on a turn boundary
    const boundary = tailPage.events[0]?.event.seq ?? 0
    expect(boundary).toBeGreaterThan(0)
    const older = await api.sessions.history(req({ sessionId: sid('fx-alpha'), beforeSeq: boundary, maxMessages: 10 }))
    if (!older.result.ok) throw new Error('older failed')
    const olderTail = older.result.value.events.at(-1)?.event
    expect((olderTail?.seq ?? -1) + 1).toBe(boundary) // pages stitch with no hole/overlap
    // Out-of-range beforeSeq clamps instead of exploding.
    const clamped = await api.sessions.history(req({ sessionId: sid('fx-alpha'), beforeSeq: -5, maxMessages: 10 }))
    if (!clamped.result.ok) throw new Error('clamped failed')
    expect(clamped.result.value.events).toEqual([])
    // Unknown session: empty page, not an error (history of a bare id).
    const empty = await api.sessions.history(req({ sessionId: sid('no-such'), maxMessages: 10 }))
    if (!empty.result.ok) throw new Error('empty failed')
    expect(empty.result.value).toEqual({ events: [], hasMore: false })
  })

  it('create adds a session and pushes host/session-added to open host streams', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const seen: HostFrame[] = []
    const consuming = (async () => {
      for await (const envelope of api.events.host(req({}), abort.signal)) {
        seen.push(envelope.payload)
        if (seen.length >= 1) abort.abort()
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 10)) // let the stream register
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    await consuming
    if (!created.result.ok) throw new Error('create failed')
    const createdId = created.result.value.sessionId
    expect(seen).toEqual([{ type: 'host/session-added', sessionId: createdId }])
    const list = await api.sessions.list(req({}))
    if (!list.result.ok) throw new Error('list failed')
    expect(list.result.value.items.some(s => s.sessionId === createdId)).toBe(true)
  })

  it('prompt replays a full streamed turn and cancel mid-replay freezes with (已中断)', async () => {
    const api = createFixtureApi()
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    const abort = new AbortController()
    const frames: MuxFrame[] = []
    const consuming = (async () => {
      for await (const envelope of api.events.mux(req({}), abort.signal)) {
        frames.push(envelope.payload)
        const last = envelope.payload
        if (last.type === 'session/event' && last.event.type === 'turn/end') {
          abort.abort()
        }
      }
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    // Unknown session → session-not-found with the id echoed in details.
    const missing = await api.sessions.prompt(req({ sessionId: sid('ghost'), mode: 'queue' as const, content: [{ type: 'text' as const, text: 'x' }] }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'session-not-found', details: { sessionId: 'ghost' } } })
    // Real prompt: replay starts (running flips true), cancel freezes it.
    const accepted = await api.sessions.prompt(req({ sessionId: id, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'render markdown' }] }))
    expect(accepted.result).toMatchObject({ ok: true, value: { accepted: true } })
    await new Promise(resolve => setTimeout(resolve, 120)) // a couple of typewriter ticks
    await api.sessions.cancel(req({ sessionId: id }))
    await consuming
    const types = frames.filter((f): f is Extract<MuxFrame, { type: 'session/event' }> => f.type === 'session/event').map(f => f.event.type)
    expect(types).toContain('turn/start')
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/chunk')
    expect(types).toContain('assistant/message')
    expect(types.at(-1)).toBe('turn/end')
    const finalize = frames.find((f): f is Extract<MuxFrame, { type: 'session/event' }> => f.type === 'session/event' && f.event.type === 'assistant/message')
    expect(JSON.stringify(finalize?.event.data)).toContain('（已中断）')
    // Idle cancel: no replay in flight, must not explode; running flips false.
    const idleCancel = await api.sessions.cancel(req({ sessionId: id }))
    expect(idleCancel.result).toMatchObject({ ok: true })
  })

  it('steer during a replay inserts a steering message and the replay continues to completion', async () => {
    const api = createFixtureApi()
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    const abort = new AbortController()
    const framesPromise = collect<MuxFrame>(api.events.mux(req({}), abort.signal), abort,
      frames => frames.some(f => f.type === 'session/event' && f.event.type === 'turn/end'))
    await new Promise(resolve => setTimeout(resolve, 10))
    await api.sessions.prompt(req({ sessionId: id, mode: 'queue' as const, content: [{ type: 'text' as const, text: '短' }] }))
    await api.sessions.prompt(req({ sessionId: id, mode: 'steer' as const, content: [{ type: 'text' as const, text: '插话' }] }))
    const frames = await framesPromise
    const types = frames.filter((f): f is Extract<MuxFrame, { type: 'session/event' }> => f.type === 'session/event').map(f => f.event.type)
    expect(types).toContain('steering/message')
    expect(types.at(-1)).toBe('turn/end') // steer did not restart the turn
  })

  it('mux open replays the baseline: subscribed for running sessions + the resident approval with a stable rpcId', async () => {
    const api = createFixtureApi()
    const openOnce = async (): Promise<RpcRequest<MuxFrame>[]> => {
      const abort = new AbortController()
      const envelopes: RpcRequest<MuxFrame>[] = []
      for await (const envelope of api.events.mux(req({}), abort.signal)) {
        envelopes.push(envelope)
        if (envelopes.length >= 2) abort.abort()
      }
      return envelopes
    }
    const first = await openOnce()
    const second = await openOnce()
    expect(first[0]?.payload).toMatchObject({ type: 'session/subscribed', sessionId: 'fx-alpha' })
    expect((first[0]?.payload as { lastSeq: number }).lastSeq).toBeGreaterThan(0)
    expect(first[1]?.payload).toMatchObject({ type: 'approval/requested', toolName: 'dangerous_tool' })
    expect(second[1]?.rpcId).toBe(first[1]?.rpcId) // stable rpcId across replays (host replay semantics)
  })

  it('steer with no replay in flight falls through to a fresh queued turn; non-text blocks stringify empty', async () => {
    const api = createFixtureApi()
    const abort = new AbortController()
    const framesPromise = collect<MuxFrame>(api.events.mux(req({}), abort.signal), abort,
      frames => frames.some(f => f.type === 'session/event' && f.event.type === 'turn/end'))
    await new Promise(resolve => setTimeout(resolve, 10))
    const created = await api.sessions.create(req({}))
    if (!created.result.ok) throw new Error('create failed')
    // steer while idle + a non-text content block (covers the '' arm of the text join).
    await api.sessions.prompt(req({
      sessionId: created.result.value.sessionId, mode: 'steer' as const,
      content: [{ type: 'text' as const, text: '短' }, { type: 'image', data: 'x' } as never],
    }))
    const frames = await framesPromise
    const types = frames.filter((f): f is Extract<MuxFrame, { type: 'session/event' }> => f.type === 'session/event').map(f => f.event.type)
    expect(types[0]).toBe('turn/start') // idle steer degraded to a queued turn, not a steering insert
  })

  it('gamma interval flip emits host/session-status and a running log-less session subscribes at lastSeq -1', async () => {
    vi.useFakeTimers()
    try {
      const api = createFixtureApi()
      const abort = new AbortController()
      const hostSeen: HostFrame[] = []
      const consuming = (async () => {
        for await (const envelope of api.events.host(req({}), abort.signal)) hostSeen.push(envelope.payload)
      })()
      await vi.advanceTimersByTimeAsync(5001) // interval fires: fx-gamma flips running=true (no log exists)
      expect(hostSeen).toContainEqual({ type: 'host/session-status', sessionId: sid('fx-gamma'), running: true })
      // A mux stream opened now sees gamma in the baseline with lastSeq = -1 (empty log arm).
      const mabort = new AbortController()
      const baseline: MuxFrame[] = []
      const muxConsuming = (async () => {
        for await (const envelope of api.events.mux(req({}), mabort.signal)) {
          baseline.push(envelope.payload)
          if (baseline.length >= 3) mabort.abort()
        }
      })()
      await vi.advanceTimersByTimeAsync(10)
      mabort.abort()
      await muxConsuming
      expect(baseline).toContainEqual({ type: 'session/subscribed', sessionId: sid('fx-gamma'), lastSeq: -1 })
      abort.abort()
      await vi.advanceTimersByTimeAsync(10)
      await consuming
    } finally {
      vi.useRealTimers()
    }
  })

  it('respond is a typed stub: always not-pending', async () => {
    const api = createFixtureApi()
    expect(await api.respond({ type: 'client-response', rpcId: RpcId('x'), result: { ok: true, value: {} } })).toEqual({ accepted: false, reason: 'not-pending' })
  })

  it('describe answers the fixture identity', async () => {
    const api = createFixtureApi()
    const response = await api.host.describe(req({}))
    expect(response.result).toMatchObject({ ok: true, value: { version: '0.0.0-fixture', attachedSessions: 1 } })
  })

  it('timing hooks: history delay + one-shot failure, silent append, and breakStreams end open generators', async () => {
    const api = createFixtureApi()
    const hooks = timing()
    // One-shot transport failure after transit delay.
    hooks.setHistoryDelay(5)
    hooks.failNextHistory()
    await expect(api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 5 }))).rejects.toThrow(/simulated history transport failure/)
    hooks.setHistoryDelay(0)
    // The failure was one-shot: the next call succeeds.
    const ok = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 5 }))
    expect(ok.result.ok).toBe(true)
    // appendUser emits on the mux stream; appendSilent only lands in the log (lost frame).
    const abort = new AbortController()
    const seen: MuxFrame[] = []
    const consuming = (async () => {
      for await (const envelope of api.events.mux(req({}), abort.signal)) seen.push(envelope.payload)
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    hooks.appendSilent('fx-alpha', '静默丢帧')
    hooks.appendUser('fx-alpha', '正常直播')
    await vi.waitFor(() => {
      expect(seen.some(f => f.type === 'session/event' && JSON.stringify(f.event.data).includes('正常直播'))).toBe(true)
    })
    expect(seen.some(f => f.type === 'session/event' && JSON.stringify(f.event.data).includes('静默丢帧'))).toBe(false)
    // But history serves the silent event (the client's repull finds it).
    const repull = await api.sessions.history(req({ sessionId: sid('fx-alpha'), maxMessages: 5 }))
    if (!repull.result.ok) throw new Error('repull failed')
    expect(JSON.stringify(repull.result.value.events)).toContain('静默丢帧')
    // breakStreams force-ends BOTH stream kinds without the client abort.
    const habort = new AbortController()
    const hostConsuming = (async () => {
      for await (const _ of api.events.host(req({}), habort.signal)) { /* drain */ }
    })()
    await new Promise(resolve => setTimeout(resolve, 10))
    hooks.breakStreams()
    await consuming // returns because the stream broke, not because we aborted
    await hostConsuming
    expect(abort.signal.aborted).toBe(false)
    expect(habort.signal.aborted).toBe(false)
  })
})

describe('FixtureApiClient (protocol-level fake carrier)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('doFetch is an unreachable tripwire (all protocol paths overridden)', () => {
    const client = new FixtureApiClient()
    // Protected at compile time only; reach it directly to pin the tripwire message.
    expect(() => (client as unknown as { doFetch(): Promise<Response> }).doFetch()).toThrow(/doFetch must be unreachable/)
  })

  it('mints request ids, taps all four full forms, and never touches doFetch', async () => {
    const client = new FixtureApiClient()
    const tapped: RpcMessage[] = []
    client.subscribeEnvelopes(batch => tapped.push(...batch))
    const response = await client.sessions.list({})
    expect(response.result.ok).toBe(true)
    await client.respond({ type: 'client-response', rpcId: RpcId('r-x'), result: { ok: true, value: {} } })
    await vi.waitFor(() => {
      const kinds = tapped.map(m => m.type)
      expect(kinds).toContain('client-request')
      expect(kinds).toContain('server-response')
      expect(kinds).toContain('client-response')
    })
    const request = tapped.find(m => m.type === 'client-request')
    const reply = tapped.find(m => m.type === 'server-response')
    expect(request?.rpcId).toBe(reply?.rpcId) // echo discipline holds through the fake carrier
  })

  it('covers the whole unary dispatch table', async () => {
    const client = new FixtureApiClient()
    const created = await client.sessions.create({})
    if (!created.result.ok) throw new Error('create failed')
    const id = created.result.value.sessionId
    expect((await client.sessions.history({ sessionId: id })).result.ok).toBe(true)
    expect((await client.sessions.prompt({ sessionId: id, mode: 'queue', content: [{ type: 'text', text: '嗨' }] })).result.ok).toBe(true)
    expect((await client.sessions.cancel({ sessionId: id })).result.ok).toBe(true)
    expect((await client.host.describe({})).result.ok).toBe(true)
  })

  it('fires onOpen at stream-iteration start and taps server-request full forms', async () => {
    const client = new FixtureApiClient()
    const tapped: RpcMessage[] = []
    client.subscribeEnvelopes(batch => tapped.push(...batch))
    const order: string[] = []
    const abort = new AbortController()
    for await (const envelope of client.events.mux({}, abort.signal, () => order.push('open'))) {
      order.push(envelope.payload.type)
      abort.abort()
    }
    expect(order[0]).toBe('open')
    expect(order[1]).toBe('session/subscribed')
    await vi.waitFor(() => {
      expect(tapped.some(m => m.type === 'server-request')).toBe(true)
    })
    // Host stream side of the pair (same tap path).
    const habort = new AbortController()
    const hostOrder: string[] = []
    const hostIterator = client.events.host({}, habort.signal, () => hostOrder.push('open'))[Symbol.asyncIterator]()
    const raced = await Promise.race([hostIterator.next(), new Promise<'idle'>(resolve => setTimeout(() => { resolve('idle') }, 50))])
    expect(hostOrder).toEqual(['open']) // established even though the host stream stays silent
    habort.abort()
    if (raced === 'idle') await hostIterator.return?.(undefined)
  })
})
