/**
 * Wire-to-typed-event bridge: a `host/remote-event` frame is handed verbatim to
 * the Remote service's `$dispatch` (its fan-out to `ctx.remote.$on` is
 * api-gateway's own coverage);
 * host/session-preset-changed → ctx 'session/preset-changed';
 * `host/models-changed` still broadcasts the typed `models/changed`; each
 * established connection generation → ctx 'connection/reset' (the forced
 * cache-invalidation broadcast).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ConnectionHandle, ConnectionSinks } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
// Type-only: the api-remotes facade carries both the allowlist's selection seat
// and the owner packages' `./types` declarations, which together give `$on` its
// key face and per-event listener signatures.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import * as RuntimeClient from '../src/client/index.ts'
import { FakeApiClient } from './fake-api.ts'

/**
 * Compile-time face of `ctx.remote.$on`, asserted by type-checking this file
 * rather than by running it: the allowlist narrows the key set, and each
 * listener's parameters come from the owner package's own cordis `Events`
 * declaration (so a brand cannot be flattened on the way to a consumer).
 * @param ctx - any client Context carrying the Remote service.
 */
function forwardedEventContracts(ctx: Context): void {
  ctx.remote.$on('settings/document-updated', (namespace, source) => {
    // @ts-expect-error -- the brand survives the wire: a bare string is not a SettingsNamespace
    const bare: typeof namespace = 'plain-string'
    void bare; void namespace; void source
  })
  ctx.remote.$on('credentials/updated', () => {})
  ctx.remote.$on('commands/change', () => {})
  // @ts-expect-error -- client-local event outside the allowlist
  ctx.remote.$on('slots/changed', () => {})
  // @ts-expect-error -- declared host event the allowlist does not select
  ctx.remote.$on('skills/change', () => {})
}
void forwardedEventContracts

interface Bench {
  ctx: Context
  sinks: ConnectionSinks | undefined
  /** Every `$dispatch` the runtime made, as `[event, ...args]`. */
  dispatched: unknown[][]
}

async function mount(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const api = new FakeApiClient()
  const bench: Bench = { ctx, sinks: undefined, dispatched: [] }
  // Stands in for api-gateway's Remote service: this spec owns the carrier's
  // handoff, not the fan-out behind it.
  ctx.reflect.provide('remote', {
    $dispatch: (event: string, args: readonly unknown[]) => { bench.dispatched.push([event, ...args]) },
  })
  const handle: ConnectionHandle = {
    api,
    isLoopback: true,
    rpc: {
      call: () => Promise.reject(new Error('unexpected generic RPC call')),
    },
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
  it('republishes a forwarded host event verbatim, and routes no other host frame there', async () => {
    const bench = await mount()
    const seen = bench.dispatched
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r1' as never,
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })
    expect(seen).toEqual([['commands/change']])

    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r2' as never,
      payload: { type: 'host/session-status', sessionId: 's1' as never, running: true },
    })
    expect(seen).toEqual([['commands/change']])
  })

  it('carries each forwarded event name with its own argument list, unfiltered', async () => {
    const bench = await mount()
    const seen = bench.dispatched

    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r3' as never,
      payload: { type: 'host/remote-event', event: 'settings/document-updated', args: ['llm-pi-ai', 7] },
    })
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r4' as never,
      payload: { type: 'host/remote-event', event: 'credentials/updated', args: ['OPENAI_API_KEY'] },
    })
    // The carrier does not second-guess the name: selecting what a consumer can
    // receive is the allowlist's job, and dropping an unsubscribed name is the
    // Remote service's. This plugin republishes whatever the frame carried.
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r5' as never,
      payload: { type: 'host/remote-event', event: 'nobody/listening', args: ['ignored'] },
    })

    expect(seen).toEqual([
      ['settings/document-updated', 'llm-pi-ai', 7],
      ['credentials/updated', 'OPENAI_API_KEY'],
      ['nobody/listening', 'ignored'],
    ])
  })

  it('still broadcasts the typed models/changed invalidation (its host frame is unchanged)', async () => {
    const bench = await mount()
    let models = 0
    bench.ctx.on('models/changed', () => { models++ })
    bench.sinks?.onHostEnvelope?.({ rpcId: 'r6' as never, payload: { type: 'host/models-changed' } })
    expect(models).toBe(1)
  })

  it('broadcasts session/preset-changed with the recomposed session and its new preset', async () => {
    const bench = await mount()
    const seen: Array<[string, string]> = []
    bench.ctx.on('session/preset-changed', (sessionId, agentPreset) => { seen.push([sessionId, agentPreset]) })
    bench.sinks?.onHostEnvelope?.({
      rpcId: 'r1' as never,
      payload: { type: 'host/session-preset-changed', sessionId: 's1' as never, agentPreset: 'minimal' },
    })
    expect(seen).toEqual([['s1', 'minimal']])
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
