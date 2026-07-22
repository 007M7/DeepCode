/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and the single-consumer stream-loop ownership.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type ConnectionHandle } from '../src/client/index.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'

type Win = { location?: { search: string } }

afterEach(() => {
  delete (globalThis as Win).location
})

async function mount(): Promise<ConnectionHandle> {
  const ctx = new Context()
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('mounts ctx.connection with the real client when no ?fixture switch is present', async () => {
    ;(globalThis as Win).location = { search: '' }
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
  })

  it('selects the fixture client under ?fixture (and with no location at all stays real)', async () => {
    ;(globalThis as Win).location = { search: '?fixture' }
    expect((await mount()).api).toBeInstanceOf(FixtureApiClient)
    delete (globalThis as Win).location
    expect((await mount()).api).toBeInstanceOf(WebApiClient)
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the streams', async () => {
    ;(globalThis as Win).location = { search: '?fixture' }
    const handle = await mount()
    // config omitted: the `config ?? {}` default arm is part of the surface.
    const loop = handle.start({})
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    loop.stop() // teardown must not throw; the fixture streams abort quietly
  })

  it('WebApiClient carries requests over globalThis.fetch', async () => {
    ;(globalThis as Win).location = { search: '' }
    const handle = await mount()
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (input: URL | RequestInfo) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    try {
      // Schema rejection is fine — the transport hop is the assertion.
      await (handle.api as WebApiClient).host.describe({}).catch(() => undefined)
    } finally {
      globalThis.fetch = original
    }
    expect(seen.some(u => u.includes('/api/'))).toBe(true)
  })
})
