/**
 * Wire-to-typed-event bridge (web input-triggers cut 1): host/commands-changed
 * → ctx 'commands/changed'; each established connection generation →
 * ctx 'connection/reset' (the forced cache-invalidation broadcast).
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { ConnectionHandle, ConnectionSinks } from '@deepseek-ai/dsh-client-connection/client'
import * as RuntimeClient from '../src/client/index.ts'
import { FakeApiClient } from './fake-api.ts'

interface Bench {
  ctx: Context
  sinks: ConnectionSinks | undefined
}

async function mount(): Promise<Bench> {
  const ctx = new Context()
  const api = new FakeApiClient()
  const bench: Bench = { ctx, sinks: undefined }
  const handle: ConnectionHandle = {
    api,
    start: (sinks) => {
      bench.sinks = sinks
      return { stop: () => {} }
    },
  }
  ctx.reflect.provide('connection', handle)
  await ctx.plugin(RuntimeClient).await()
  return bench
}

describe('wire event bridge', () => {
  it('broadcasts commands/changed on a host/commands-changed frame, not on other host frames', async () => {
    const bench = await mount()
    let changed = 0
    bench.ctx.on('commands/changed', () => { changed++ })
    bench.sinks?.onHostEnvelope?.({ rpcId: 'r1' as never, payload: { type: 'host/commands-changed' } })
    expect(changed).toBe(1)
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r2' as never,
      payload: { type: 'host/session-status', sessionId: 's1' as never, running: true },
    })
    expect(changed).toBe(1)
  })

  it('broadcasts connection/reset on every established generation (reconnect invalidation)', async () => {
    const bench = await mount()
    let resets = 0
    bench.ctx.on('connection/reset', () => { resets++ })
    bench.sinks?.onConnected?.()
    bench.sinks?.onConnected?.() // second generation after a reconnect
    expect(resets).toBe(2)
  })
})
