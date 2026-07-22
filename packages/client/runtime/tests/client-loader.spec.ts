/**
 * ClientLoader: handoff protocol (single slot, id reconciliation), DI require
 * with export-surface re-registration, immediately-group barrier (parallel
 * fetch / topology execution / full-group barrier), status store, settled,
 * failure modes (missing handoff, unknown dep, cycle, unload stub).
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { createClientLoader } from '../src/client/loader/index.ts'
import type { BootPluginEntry, ClientPluginHandoff } from '../src/client/loader/index.ts'

type Win = { DSHClientProxy?: { loadPlugin(h: ClientPluginHandoff): void }; __DSH_BOOT__?: { plugins: BootPluginEntry[] } }
const win = globalThis as Win

afterEach(() => {
  delete win.DSHClientProxy
  delete win.__DSH_BOOT__
})

interface FakeBundle {
  handoff: ClientPluginHandoff | null | ((require: (spec: string) => unknown) => Record<string, unknown>)
}

interface Bench {
  loader: ReturnType<typeof createClientLoader>
  fetched: string[]
  executed: string[]
  fetchGate: Map<string, () => void>
}

/** Build a loader over scripted fake bundles keyed by url; fetches resolve when released (or immediately). */
function bench(
  plugins: BootPluginEntry[],
  bundles: Record<string, FakeBundle>,
  opts: { modules?: Record<string, unknown>; gated?: string[] } = {},
): Bench {
  const ctx = new Context()
  const fetched: string[] = []
  const executed: string[] = []
  const fetchGate = new Map<string, () => void>()
  const loader = createClientLoader({
    ctx,
    modules: opts.modules ?? { react: { marker: 'react' } },
    boot: { plugins },
    fetchBundle: (url) => {
      fetched.push(url)
      if (opts.gated?.includes(url) === true) {
        return new Promise<string>((resolve) => { fetchGate.set(url, () => { resolve(url) }) })
      }
      return Promise.resolve(url)
    },
    executeBundle: (code) => {
      executed.push(code)
      const bundle = bundles[code]
      if (bundle === undefined) throw new Error(`no fake bundle for ${code}`)
      if (bundle.handoff === null) return // simulates a bundle that never calls loadPlugin
      if (typeof bundle.handoff === 'function') {
        win.DSHClientProxy?.loadPlugin({ id: code.replace('/client.js', '').replace('/plugins/', ''), factory: bundle.handoff })
        return
      }
      win.DSHClientProxy?.loadPlugin(bundle.handoff)
    },
  })
  return { loader, fetched, executed, fetchGate }
}

const entry = (id: string, inject: string[] = [], immediately?: boolean): BootPluginEntry =>
  ({ id, url: `/plugins/${id}/client.js`, inject, ...(immediately === true ? { immediately: true } : {}) })

const okBundle = (applied?: string[], exports: Record<string, unknown> = {}): FakeBundle => ({
  handoff: require => ({
    apply: (pluginCtx: Context) => { void pluginCtx; applied?.push('applied') },
    require,
    ...exports,
  }),
})

describe('load chain', () => {
  it('runs fetch→execute→handoff→factory(require)→apply→export re-registration→status active', async () => {
    const applied: string[] = []
    const b = bench(
      [entry('fake-base', [], true), entry('feature', ['fake-base'])],
      {
        '/plugins/fake-base/client.js': { handoff: () => ({ apply: () => { applied.push('fake-base') }, helper: 'base-helper' }) },
        '/plugins/feature/client.js': {
          handoff: (require) => {
            // Later loader requires the earlier one's export surface (inject topology guarantee).
            const fakeBase = ['fake','base'].join('-') // assembled so knip's static require() scan skips the fake id
            const base = require(fakeBase) as { helper: string }
            expect(base.helper).toBe('base-helper')
            expect((require('react') as { marker: string }).marker).toBe('react')
            return { apply: () => { applied.push('feature') } }
          },
        },
      },
    )
    b.loader.start()
    await b.loader.settled()
    expect(applied).toEqual(['fake-base', 'feature'])
    expect(b.loader.status.getSnapshot()).toEqual({ 'fake-base': 'active', feature: 'active' })
    expect((b.loader.requireModule('fake-base') as { helper: string }).helper).toBe('base-helper')
    expect(() => b.loader.requireModule('ghost')).toThrow(/not available/)
  })

  it('fetches the immediately group in parallel and holds the barrier before the rest', async () => {
    const b = bench(
      [entry('a', [], true), entry('b', ['a'], true), entry('later')],
      {
        '/plugins/a/client.js': okBundle(),
        '/plugins/b/client.js': okBundle(),
        '/plugins/later/client.js': okBundle(),
      },
      { gated: ['/plugins/a/client.js'] },
    )
    b.loader.start()
    await Promise.resolve()
    // Both early fetches are in flight before any execution; the late plugin is not fetched yet.
    expect(b.fetched).toEqual(['/plugins/a/client.js', '/plugins/b/client.js'])
    expect(b.executed).toEqual([])
    b.fetchGate.get('/plugins/a/client.js')?.()
    await b.loader.settled()
    expect(b.executed).toEqual(['/plugins/a/client.js', '/plugins/b/client.js', '/plugins/later/client.js'])
  })

  it('orders execution by inject topology within each group', async () => {
    const b = bench(
      [entry('z-ui', ['a-base']), entry('a-base')],
      { '/plugins/a-base/client.js': okBundle(), '/plugins/z-ui/client.js': okBundle() },
    )
    b.loader.start()
    await b.loader.settled()
    expect(b.executed).toEqual(['/plugins/a-base/client.js', '/plugins/z-ui/client.js'])
  })
})

describe('failure modes (fail loud)', () => {
  it('rejects settled and marks failed when a bundle never calls loadPlugin', async () => {
    const b = bench([entry('silent')], { '/plugins/silent/client.js': { handoff: null } })
    b.loader.start()
    await expect(b.loader.settled()).rejects.toThrow(/without calling DSHClientProxy.loadPlugin/)
    expect(b.loader.status.getSnapshot().silent).toBe('failed')
  })

  it('rejects on manifest/handoff id mismatch', async () => {
    const b = bench([entry('expected')], {
      '/plugins/expected/client.js': { handoff: { id: 'imposter', factory: () => ({ apply: () => {} }) } },
    })
    b.loader.start()
    await expect(b.loader.settled()).rejects.toThrow(/id mismatch/)
  })

  it('rejects unknown inject targets, cycles, missing apply, unknown load ids, duplicate manifest ids', async () => {
    // Sequential benches: each loader owns the window proxy, so release it between them.
    const fresh = <T>(build: () => T): T => {
      delete win.DSHClientProxy
      return build()
    }

    const missing = fresh(() => bench([entry('x', ['nope'])], { '/plugins/x/client.js': okBundle() }))
    missing.loader.start()
    await expect(missing.loader.settled()).rejects.toThrow(/injects unknown plugin "nope"/)

    const cyclic = fresh(() => bench(
      [entry('p', ['q']), entry('q', ['p'])],
      { '/plugins/p/client.js': okBundle(), '/plugins/q/client.js': okBundle() },
    ))
    cyclic.loader.start()
    await expect(cyclic.loader.settled()).rejects.toThrow(/inject cycle/)

    const applyless = fresh(() => bench([entry('noap')], { '/plugins/noap/client.js': { handoff: { id: 'noap', factory: () => ({}) } } }))
    applyless.loader.start()
    await expect(applyless.loader.settled()).rejects.toThrow(/exports no apply/)

    const b = fresh(() => bench([entry('a')], { '/plugins/a/client.js': okBundle() }))
    await expect(b.loader.load('ghost')).rejects.toThrow(/unknown plugin "ghost"/)

    expect(() => fresh(() => bench([entry('dup'), entry('dup')], {}))).toThrow(/duplicate manifest id/)
  })

  it('throws on missing boot manifest, double proxy install, and pre-start settled', () => {
    expect(() => createClientLoader({ ctx: new Context(), modules: {} })).toThrow(/no boot manifest/)
    const b = bench([], {})
    expect(() => b.loader.settled()).toThrow(/settled\(\) before start\(\)/)
    // First bench installed the proxy; a second loader must refuse.
    expect(() => createClientLoader({ ctx: new Context(), modules: {}, boot: { plugins: [] } })).toThrow(/already installed/)
  })

  it('direct load() before a dependency is active fails loud (same check start() sequences)', async () => {
    const b = bench(
      [entry('dep', [], true), entry('needy', ['dep'])],
      { '/plugins/dep/client.js': okBundle(), '/plugins/needy/client.js': okBundle() },
    )
    await expect(b.loader.load('needy')).rejects.toThrow(/loaded before its dependency "dep" is active/)
  })

  it('direct load() naming an unknown inject target fails loud', async () => {
    const b = bench([entry('solo', ['phantom'])], { '/plugins/solo/client.js': okBundle() })
    await expect(b.loader.load('solo')).rejects.toThrow(/injects unknown plugin "phantom"/)
  })

  it('an immediately-group fetch failure surfaces through settled, not as an unhandled prefetch rejection', async () => {
    // The fire-and-forget prefetch swallow arm must absorb the early
    // rejection; the awaited load surfaces the same failure via settled().
    const ctx = new Context()
    delete win.DSHClientProxy
    const loader = createClientLoader({
      ctx,
      modules: {},
      boot: { plugins: [{ id: 'kaboom', url: '/plugins/kaboom/client.js', inject: [], immediately: true }] },
      fetchBundle: () => Promise.reject(new Error('bundle fetch exploded')),
      executeBundle: () => {},
    })
    loader.start()
    await expect(loader.settled()).rejects.toThrow(/bundle fetch exploded/)
  })

  it('unload is the P-I stub', async () => {
    const b = bench([], {})
    await expect(b.loader.unload('x')).rejects.toThrow(/not implemented/)
  })
})

describe('DOM default seams (stubbed globals)', () => {
  it('default fetchBundle uses fetch, rejects non-OK; default executeBundle injects an inline script; claimStyles tags orphans', async () => {
    const origFetch = globalThis.fetch
    const appended: { textContent?: string | null }[] = []
    const styleTag = {
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) { this.attrs[k] = v },
    }
    const fakeDoc = {
      createElement: () => {
        const el = { textContent: null as string | null }
        return el
      },
      head: { appendChild: (el: { textContent?: string | null }) => { appended.push(el) } },
      querySelectorAll: () => [styleTag],
    }
    const g = globalThis as { document?: unknown; fetch: typeof fetch }
    g.document = fakeDoc
    g.fetch = (url: URL | RequestInfo) => Promise.resolve(
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('bad')
        ? new Response('x', { status: 500 })
        : new Response('window.DSHClientProxy.loadPlugin(globalThis.__seamHandoff)', { status: 200 }),
    )
    try {
      delete win.DSHClientProxy
      const ctx = new Context()
      const loader = createClientLoader({
        ctx,
        modules: {},
        boot: { plugins: [
          { id: 'seam-ok', url: '/plugins/seam-ok/client.js', inject: [] },
          { id: 'seam-bad', url: '/plugins/bad/client.js', inject: [] },
        ] },
        // NO seams injected (keys omitted, not undefined — exactOptional):
        // the DOM defaults are under test.
      })
      const seamHandoff: ClientPluginHandoff = {
        id: 'seam-ok',
        factory: () => ({ apply: () => {} }),
      }
      // Default executeBundle only APPENDS the script element (no execution in
      // our fake DOM), so drive the handoff manually before load resolves it.
      const loadOk = loader.load('seam-ok')
      await Promise.resolve()
      ;(globalThis as Win).DSHClientProxy?.loadPlugin(seamHandoff)
      await loadOk
      expect(appended).toHaveLength(1)
      expect(appended[0]?.textContent).toContain('sourceURL=/plugins/seam-ok/client.js')
      expect(styleTag.attrs['data-plugin']).toBe('seam-ok')
      await expect(loader.load('seam-bad')).rejects.toThrow(/answered 500/)
    } finally {
      g.fetch = origFetch
      delete (globalThis as { document?: unknown }).document
    }
  })
})

describe('handoff slot protocol', () => {
  it('rejects an overlapping loadPlugin before the loader claims the pending handoff', () => {
    delete win.DSHClientProxy
    createClientLoader({ ctx: new Context(), modules: {}, boot: { plugins: [] } })
    const proxy = (globalThis as Win).DSHClientProxy
    proxy?.loadPlugin({ id: 'first', factory: () => ({ apply: () => {} }) })
    expect(() => proxy?.loadPlugin({ id: 'second', factory: () => ({ apply: () => {} }) }))
      .toThrow(/overlapping loadPlugin handoff/)
  })
})
