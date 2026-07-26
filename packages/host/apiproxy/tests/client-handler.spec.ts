/**
 * Wire-protocol coverage over the isomorphic point: InProcessApiClient →
 * toFetchHandler(scripted impl) runs the real envelope wrap/unwrap, zod
 * two-level parse, rpcId discipline, and SSE framing with no network and no
 * browser. Each case scripts its own minimal ApiProxy.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApiProxy, HostFrame, MuxFrame, RpcMessage, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy'
import { InProcessApiClient, RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

function ok<T>(request: RpcRequest<unknown>, value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value } })
}

/** Scripted impl: every method resolves an empty-ish OK unless a case overrides it. */
function scriptedApi(overrides: {
  sessions?: Partial<ApiProxy['sessions']>
  host?: Partial<ApiProxy['host']>
  events?: Partial<ApiProxy['events']>
  respond?: ApiProxy['respond']
} = {}): ApiProxy {
  async function *empty<F>(): AsyncGenerator<RpcRequest<F>> { /* no frames */ }
  return {
    sessions: {
      list: r => ok(r, { items: [] }),
      create: r => ok(r, { sessionId: sid('s-new') }),
      history: r => ok(r, { events: [], hasMore: false }),
      prompt: r => ok(r, { accepted: true as const }),
      cancel: r => ok(r, { accepted: true as const }),
      ...overrides.sessions,
    },
    host: { describe: r => ok(r, { version: '0-test', cwd: '/t', attachedSessions: 0 }), ...overrides.host },
    workspace: {
      list: r => ok(r, { items: [] }),
      create: r => ok(r, { workspace: { workspaceId: 'w1' as never, path: '/t', title: 't', sessionIds: [], createdAt: '0', updatedAt: '0' }, created: true }),
      rename: r => ok(r, { workspace: { workspaceId: 'w1' as never, path: '/t', title: 't', sessionIds: [], createdAt: '0', updatedAt: '0' } }),
      insertSessionBefore: r => ok(r, { workspace: { workspaceId: 'w1' as never, path: '/t', title: 't', sessionIds: [], createdAt: '0', updatedAt: '0' } }),
    },
    events: { mux: () => empty<MuxFrame>(), host: () => empty<HostFrame>(), ...overrides.events },
    respond: overrides.respond ?? (() => Promise.resolve({ accepted: false as const, reason: 'not-pending' as const })),
  }
}

function client(api: ApiProxy, timeoutMs?: number): InProcessApiClient {
  return new InProcessApiClient(toFetchHandler(api), timeoutMs)
}

describe('unary round trip', () => {
  it('carries payload out and value back through the full wire form', async () => {
    let seen: RpcRequest<{ cursor?: string }> | undefined
    const api = scriptedApi({
      sessions: {
        list: (r) => {
          seen = r
          return ok(r, { items: [{ sessionId: sid('s1'), updatedAt: 7, running: false }] })
        },
      },
    })
    const response = await client(api).sessions.list({ cursor: 'c1' })
    // Impl received the narrow form with a minted id; client returned the same id and value.
    expect(seen?.payload).toEqual({ cursor: 'c1' })
    expect(seen?.rpcId).toBeTruthy()
    expect(response.rpcId).toBe(seen?.rpcId)
    expect(response.result).toEqual({ ok: true, value: { items: [{ sessionId: 's1', updatedAt: 7, running: false }] } })
  })

  it('routes workspace rename and insertSessionBefore through the wire', async () => {
    const api = scriptedApi()
    const c = client(api)
    const renamed = await c.workspace.rename({ workspaceId: 'w1' as never, title: 'next' })
    expect(renamed.result.ok).toBe(true)
    const blankTitle = await c.workspace.rename({ workspaceId: 'w1' as never, title: '   ' })
    expect(blankTitle.result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const anchored = await c.workspace.insertSessionBefore({ workspaceId: 'w1' as never, sessionId: sid('s1'), beforeSessionId: sid('s2') })
    expect(anchored.result.ok).toBe(true)
    const appended = await c.workspace.insertSessionBefore({ workspaceId: 'w1' as never, sessionId: sid('s1') })
    expect(appended.result.ok).toBe(true)
  })

  it('passes business errors through as 200 + err result, not a throw', async () => {
    const api = scriptedApi({
      sessions: {
        cancel: r => Promise.resolve({ rpcId: r.rpcId, result: { ok: false, error: { code: 'session-not-found', message: 'nope', details: { sessionId: sid('sx') } } } }),
      },
    })
    const response = await client(api).sessions.cancel({ sessionId: sid('sx') })
    expect(response.result).toEqual({ ok: false, error: { code: 'session-not-found', message: 'nope', details: { sessionId: 'sx' } } })
  })

  it('throws on rpcId echo mismatch', async () => {
    const api = scriptedApi({
      sessions: { list: () => Promise.resolve({ rpcId: RpcId('forged'), result: { ok: true, value: { items: [] } } }) },
    })
    await expect(client(api).sessions.list({})).rejects.toThrow(/rpcId mismatch/)
  })

  it('rejects an invalid payload at the handler as 200 + bad-request with issues', async () => {
    const api = scriptedApi()
    const response = await client(api).sessions.history({ sessionId: 123 as unknown as SessionId })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('bad-request')
      expect((response.result.error.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0)
    }
  })

  it('rejects a method/path mismatch as bad-request', async () => {
    const handler = toFetchHandler(scriptedApi())
    const body = { type: 'client-request', rpcId: 'r1', method: 'session.create', payload: {} }
    const response = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    const parsed = await response.json() as { result: { ok: boolean; error?: { code: string; message: string } } }
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error?.code).toBe('bad-request')
    expect(parsed.result.error?.message).toMatch(/does not match path/)
  })

  it('rejects a malformed envelope as bad-request, salvaging the rpcId or falling back to the sentinel', async () => {
    const handler = toFetchHandler(scriptedApi())
    // No salvageable rpcId → the fixed invalid-request sentinel keeps the response a valid ServerResponse.
    const noId = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', body: JSON.stringify({ nonsense: true }) })
    expect(noId.status).toBe(200)
    const noIdParsed = await noId.json() as { rpcId: string; result: { ok: boolean } }
    expect(noIdParsed.result.ok).toBe(false)
    expect(noIdParsed.rpcId).toBe('invalid-request')
    // A string rpcId in the otherwise-bad body is salvaged for correlation.
    const withId = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', body: JSON.stringify({ rpcId: 'salvage-me', nonsense: true }) })
    const withIdParsed = await withId.json() as { rpcId: string; result: { ok: boolean } }
    expect(withIdParsed.result.ok).toBe(false)
    expect(withIdParsed.rpcId).toBe('salvage-me')
  })

  it('maps carrier failures to HTTP statuses and the client throws transport failure', async () => {
    const handler = toFetchHandler(scriptedApi())
    // Unknown method → 404.
    const notFound = await handler.fetch('http://dsh.internal/api/no.such', { method: 'POST', body: '{}' })
    expect(notFound.status).toBe(404)
    // Non-JSON body → 400.
    const badBody = await handler.fetch('http://dsh.internal/api/session.list', { method: 'POST', body: '{oops' })
    expect(badBody.status).toBe(400)
    // Impl crash → 500, and through the client that is a throw, not an err result.
    const crashing = scriptedApi({ sessions: { list: () => { throw new Error('impl exploded') } } })
    await expect(client(crashing).sessions.list({})).rejects.toThrow(/transport failure .*500/)
  })

  it('rejects when the transport never resolves within timeoutMs', async () => {
    // AbortSignal.timeout is immune to fake timers; a short real timeout keeps this fast.
    const never = new InProcessApiClient({
      fetch: (_i: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by timeout')) })
      }),
    }, 25)
    await expect(never.sessions.list({})).rejects.toThrow()
  })

  it('aborts a unary call through the caller-supplied external signal', async () => {
    // Real-fetch semantics: on abort the rejection is the signal's reason, and the abort
    // works even when the transport ignores the signal entirely (hung impl).
    const gate = new AbortController()
    const hung = new InProcessApiClient({ fetch: () => new Promise<Response>(() => {}) }, 60_000)
    const call = hung.sessions.list({}, gate.signal)
    gate.abort(new Error('externally aborted'))
    await expect(call).rejects.toThrow(/externally aborted/)
  })

  it('rejects an already-aborted signal before touching the transport, mapping a string reason to an Error', async () => {
    let touched = false
    const c = new InProcessApiClient({
      fetch: () => {
        touched = true
        return Promise.resolve(new Response('{}'))
      },
    }, 60_000)
    const gate = new AbortController()
    gate.abort('gone before start')
    await expect(c.sessions.list({}, gate.signal)).rejects.toThrow('gone before start')
    expect(touched).toBe(false)
  })

  it('maps a non-Error, non-string abort reason to the default AbortError message', async () => {
    const gate = new AbortController()
    const hung = new InProcessApiClient({ fetch: () => new Promise<Response>(() => {}) }, 60_000)
    const call = hung.sessions.list({}, gate.signal)
    gate.abort(42)
    await expect(call).rejects.toThrow('This operation was aborted')
  })

  it('passes a signal-less doFetch straight through to the handler', async () => {
    class Probe extends InProcessApiClient {
      direct(url: URL): Promise<Response> {
        return this.doFetch(url)
      }
    }
    const probe = new Probe({ fetch: () => Promise.resolve(new Response('raw')) })
    const response = await probe.direct(new URL('http://dsh.internal/probe'))
    expect(await response.text()).toBe('raw')
  })

  it('throws on an S→C ok value that fails the method value schema (second-level parse)', async () => {
    // Impl echoes rpcId but returns a wrong-shaped value: envelope parse passes, value parse must reject.
    const api = scriptedApi({
      sessions: { list: r => Promise.resolve({ rpcId: r.rpcId, result: { ok: true, value: { items: 'not-an-array' } } }) as never },
    })
    await expect(client(api).sessions.list({})).rejects.toThrow()
  })
})

describe('workspace domain round trip', () => {
  it('routes both workspace methods through their handler rows and value schemas', async () => {
    const c = client(scriptedApi())
    const list = await c.workspace.list({})
    expect(list.result).toEqual({ ok: true, value: { items: [] } })
    const created = await c.workspace.create({ path: '/t' })
    expect(created.result.ok).toBe(true)
    if (created.result.ok) expect(created.result.value.created).toBe(true)
  })

  it('rejects a create payload violating the exactly-one refine at the handler', async () => {
    const response = await client(scriptedApi()).workspace.create({})
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('bad-request')
  })
})

describe('SSE stream path', () => {
  it('yields frames in order and skips the comment preamble', async () => {
    const frames: MuxFrame[] = [
      { type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 3 },
      { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } },
    ]
    const api = scriptedApi({
      events: {
        async *mux(request) {
          let n = 0
          for (const frame of frames) yield { rpcId: RpcId(`push-${n++}-${request.rpcId}`), payload: frame }
        },
      },
    })
    const seen: MuxFrame[] = []
    for await (const envelope of client(api).events.mux({}, new AbortController().signal)) {
      seen.push(envelope.payload)
    }
    expect(seen).toEqual(frames)
  })

  it('reassembles frames across arbitrary chunk boundaries', async () => {
    // Two SSE frames split so one frame spans chunks and one chunk carries parts of both.
    const f1 = { type: 'server-request', rpcId: 'a', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 1 } }
    const f2 = { type: 'server-request', rpcId: 'b', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's2', lastSeq: 2 } }
    const wire = `: connected\n\ndata: ${JSON.stringify(f1)}\n\ndata: ${JSON.stringify(f2)}\n\n`
    const cuts = [5, 40, wire.indexOf('data: ', 40) + 3]
    const encoder = new TextEncoder()
    const doFetch = (): Promise<Response> => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        let prev = 0
        for (const cut of [...cuts, wire.length]) {
          controller.enqueue(encoder.encode(wire.slice(prev, cut)))
          prev = cut
        }
        controller.close()
      },
    }), { status: 200 }))
    const chopped = new InProcessApiClient({ fetch: doFetch })
    const seen: string[] = []
    for await (const envelope of chopped.events.mux({}, new AbortController().signal)) {
      seen.push((envelope.payload as { sessionId: string }).sessionId)
      expect(envelope.rpcId).toBe(seen.length === 1 ? 'a' : 'b')
    }
    expect(seen).toEqual(['s1', 's2'])
  })

  it('emits a stream/error frame then closes when the impl throws mid-stream', async () => {
    const api = scriptedApi({
      events: {
        async *host(request): AsyncGenerator<RpcRequest<HostFrame>> {
          yield { rpcId: RpcId(`p-${request.rpcId}`), payload: { type: 'host/session-added', sessionId: sid('s1') } }
          throw new Error('impl died mid-stream')
        },
      },
    })
    const seen: HostFrame[] = []
    for await (const envelope of client(api).events.host({}, new AbortController().signal)) {
      seen.push(envelope.payload)
    }
    expect(seen.map(f => f.type)).toEqual(['host/session-added', 'stream/error'])
    const last = seen.at(-1)
    if (last?.type === 'stream/error') expect(last.error.message).toMatch(/impl died mid-stream/)
  })

  it('drops a malformed SSE frame and keeps the stream alive (S→C two-level parse)', async () => {
    const good = { type: 'server-request', rpcId: 'g1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 1 } }
    const badEnvelope = { type: 'server-response', rpcId: 'x' } // wrong quadrant for a stream
    const badFrame = { type: 'server-request', rpcId: 'b1', method: 'nope', payload: { type: 'no/such-frame' } }
    const wire = [
      'data: {oops', // not JSON
      `data: ${JSON.stringify(badEnvelope)}`,
      `data: ${JSON.stringify(badFrame)}`,
      `data: ${JSON.stringify(good)}`,
    ].map(l => `${l}\n\n`).join('')
    const doFetch = (): Promise<Response> => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire))
        controller.close()
      },
    }), { status: 200 }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const seen: MuxFrame[] = []
      for await (const envelope of new InProcessApiClient({ fetch: doFetch }).events.mux({}, new AbortController().signal)) {
        seen.push(envelope.payload)
      }
      // The three corrupt frames are reported and skipped; the good one still arrives.
      expect(seen).toEqual([{ type: 'session/subscribed', sessionId: 's1', lastSeq: 1 }])
      expect(errorSpy.mock.calls.length).toBe(3)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('fires onOpen once headers are in, before the first frame, and not on transport failure', async () => {
    const api = scriptedApi({
      events: {
        async *mux(request): AsyncGenerator<RpcRequest<MuxFrame>> {
          yield { rpcId: RpcId(`p-${request.rpcId}`), payload: { type: 'session/subscribed', sessionId: sid('s1'), lastSeq: 0 } }
        },
      },
    })
    const order: string[] = []
    const iterator = client(api).events.mux({}, new AbortController().signal, () => order.push('open'))
    expect(order).toEqual([]) // lazy generator: no fetch (and no onOpen) before iteration
    for await (const _ of iterator) order.push('frame')
    expect(order).toEqual(['open', 'frame'])

    // Transport failure path: onOpen must not fire.
    const failing = new InProcessApiClient({ fetch: () => Promise.resolve(new Response('down', { status: 503 })) })
    const failOrder: string[] = []
    await expect((async () => {
      for await (const _ of failing.events.mux({}, new AbortController().signal, () => failOrder.push('open'))) { /* unreachable */ }
    })()).rejects.toThrow(/transport failure/)
    expect(failOrder).toEqual([])
  })

  it('stops consuming when the caller aborts', async () => {
    let implSawAbort = false
    const api = scriptedApi({
      events: {
        async *mux(_request, signal): AsyncGenerator<RpcRequest<MuxFrame>> {
          try {
            let n = 0
            while (true) {
              yield { rpcId: RpcId(`p${n}`), payload: { type: 'session/subscribed', sessionId: sid('s1'), lastSeq: n++ } }
              await new Promise(resolve => setTimeout(resolve, 5))
              if (signal.aborted) return
            }
          } finally {
            implSawAbort = true
          }
        },
      },
    })
    const abort = new AbortController()
    let count = 0
    // In-process abort ends the stream (impl returns on signal.aborted); over a real
    // network fetch the same abort surfaces as a rejection — both stop the loop.
    await (async () => {
      for await (const _ of client(api).events.mux({}, abort.signal)) {
        if (++count === 2) abort.abort()
      }
    })().catch(() => undefined)
    expect(count).toBe(2)
    // Generator teardown may lag the abort by a microtask; poll briefly.
    await vi.waitFor(() => { expect(implSawAbort).toBe(true) })
  })
})

describe('respond path', () => {
  it('round-trips a client-response to a receipt', async () => {
    const seen: unknown[] = []
    const api = scriptedApi({
      respond: (message) => {
        seen.push(message)
        return Promise.resolve({ accepted: true as const })
      },
    })
    const receipt = await client(api).respond({ type: 'client-response', rpcId: RpcId('req-1'), result: { ok: true, value: { behavior: 'allow' } } })
    expect(receipt).toEqual({ accepted: true })
    expect(seen).toEqual([{ type: 'client-response', rpcId: 'req-1', result: { ok: true, value: { behavior: 'allow' } } }])
  })

  it('returns bad-response for a malformed client-response without reaching the impl', async () => {
    const respond = vi.fn()
    const handler = toFetchHandler(scriptedApi({ respond }))
    const response = await handler.fetch('http://dsh.internal/api/respond', { method: 'POST', body: JSON.stringify({ type: 'client-response' }) })
    expect(await response.json()).toEqual({ accepted: false, reason: 'bad-response' })
    expect(respond).not.toHaveBeenCalled()
  })
})

describe('envelope tap', () => {
  it('delivers one microtask batch of full forms per unary call', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    const batches: (readonly RpcMessage[])[] = []
    tapped.subscribeEnvelopes(batch => batches.push(batch))
    await tapped.sessions.list({})
    await vi.waitFor(() => { expect(batches.length).toBeGreaterThan(0) })
    const all = batches.flat()
    expect(all.map(m => m.type)).toEqual(['client-request', 'server-response'])
    expect(all[0]?.rpcId).toBe(all[1]?.rpcId)
  })

  it('isolates a throwing listener and keeps serving the call', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const good: string[] = []
      tapped.subscribeEnvelopes(() => { throw new Error('listener bug') })
      tapped.subscribeEnvelopes(batch => good.push(...batch.map(m => m.type)))
      const response = await tapped.sessions.list({})
      expect(response.result.ok).toBe(true)
      await vi.waitFor(() => { expect(good).toContain('server-response') })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('buffers nothing with zero subscribers and unsubscribes cleanly', async () => {
    const api = scriptedApi()
    const tapped = client(api)
    await tapped.sessions.list({}) // no subscribers: must not accumulate
    const batches: (readonly RpcMessage[])[] = []
    const unsubscribe = tapped.subscribeEnvelopes(batch => batches.push(batch))
    unsubscribe()
    await tapped.sessions.list({})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(batches).toEqual([])
  })
})
