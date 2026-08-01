/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and the single-consumer stream-loop ownership.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type ConnectionHandle } from '../src/client/index.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'

type Win = { location?: { search: string; protocol?: string; hostname?: string }; __DSH_FILES_PORT__?: number }

afterEach(() => {
  delete (globalThis as Win).location
  delete (globalThis as Win).__DSH_FILES_PORT__
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

  it('addresses a workspace file on the port the host published, and only inside the workspace', async () => {
    const win = globalThis as Win
    win.location = { search: '', protocol: 'http:', hostname: '192.168.1.5' }
    win.__DSH_FILES_PORT__ = 4321
    const handle = await mount()
    const session = 's-1' as never
    // Same hostname the page was reached by — a LAN client must reach previews
    // too — and the published port, which is what makes it another origin.
    expect(handle.fileUrl(session, '/w/alpha', '/w/alpha/out/a b.html'))
      .toBe('http://192.168.1.5:4321/f/s-1/out/a%20b.html')
    // Outside the workspace there is nothing this transport may serve, which
    // is the signal a caller falls back to openPath on.
    expect(handle.fileUrl(session, '/w/alpha', '/etc/hosts')).toBeUndefined()
  })

  it('serves no file URL on a page no host published a port into', async () => {
    const win = globalThis as Win
    win.location = { search: '?fixture', protocol: 'http:', hostname: '127.0.0.1' }
    const handle = await mount()
    // The keyless fixture lane: no workspace-file origin exists, so the row
    // falls back to the Host opener instead of opening a dead tab.
    expect(handle.fileUrl('s-1' as never, '/w', 'a.txt')).toBeUndefined()
  })
})
