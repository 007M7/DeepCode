/**
 * Runtime plugin browser-half apply: slots + sessions mounting over the
 * connection handle, stream-loop sink wiring into the object layer, and the
 * fiber-scoped loop teardown.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionSinks } from '@deepseek-ai/dsh-client-connection/client'
import * as RuntimeClient from '../src/client/index.ts'
import { FakeApiClient } from './fake-api.ts'

interface Bench {
  ctx: Context
  api: FakeApiClient
  sinks: ConnectionSinks | undefined
  stopped: number
}

async function mount(): Promise<Bench> {
  const ctx = new Context()
  const api = new FakeApiClient()
  const bench: Bench = { ctx, api, sinks: undefined, stopped: 0 }
  const handle: ConnectionHandle = {
    api,
    start: (sinks) => {
      bench.sinks = sinks
      return { stop: () => { bench.stopped += 1 } }
    },
  }
  ctx.reflect.provide('connection', handle)
  await ctx.plugin(RuntimeClient).await()
  return bench
}

describe('runtime client apply', () => {
  it('mounts ctx.slots + ctx.sessions and wires the stream sinks into the manager', async () => {
    const bench = await mount()
    expect(bench.ctx.get('slots') !== undefined).toBe(true)
    // The built-in 'root' declaration ships with this package's SlotsService
    // (the SlotMap 'root' merge lives here since the slot-parity rework).
    expect(bench.ctx.slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
    const sessions = bench.ctx.get('sessions')
    expect(sessions !== undefined).toBe(true)
    expect(bench.sinks).toBeDefined()

    // Frame sinks reach the object layer: a host session-added lands in the list store.
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r1' as never,
      payload: { type: 'host/session-added', sessionId: 's-new' } as never,
    })
    await Promise.resolve()
    expect((sessions as { list: { getSnapshot(): { ids: string[] } } }).list.getSnapshot().ids).toContain('s-new')
    // Mux sink and onConnected route without throwing (manager semantics own the behavior).
    bench.sinks?.onMuxEnvelope?.({ rpcId: 'r2' as never, payload: { type: 'stream/error', message: 'x' } as never })
    bench.sinks?.onConnected?.()
  })

  it('stops the stream loop when the plugin fiber unloads', async () => {
    const bench = await mount()
    const fiber = [...bench.ctx.registry.values()].find(f => f.name?.includes('client'))
    // Dispose the whole tree: the ctx.effect teardown must call loop.stop exactly once.
    await bench.ctx.fiber.dispose()
    expect(bench.stopped).toBe(1)
    void fiber
  })
})
