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

  it('unload is the P-I stub', async () => {
    const b = bench([], {})
    await expect(b.loader.unload('x')).rejects.toThrow(/not implemented/)
  })
})
