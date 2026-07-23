/**
 * mountWebPlugins unit coverage (keyless; the real nine-package walk is the
 * built-artifact e2e). The Loader-facing behavior — baseUrl anchoring, entry
 * creation with idempotent reuse, the fiber-less fail-loud sweep, and the
 * resolver seam — is exercised against a stubbed loader service so it runs
 * without built lib/ artifacts.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { WEB_UI_PLUGINS, mountWebPlugins } from '../src/web-plugins.ts'

interface FakeEntry {
  options: { name: string }
  fiber?: unknown
  disabled: boolean
}

/** Loader stub provided under the real service name (mountWebPlugins skips ctx.plugin(Loader) when present). */
class FakeLoader {
  readonly created: string[] = []
  awaited = 0
  constructor(private readonly entriesList: FakeEntry[], private readonly onCreate?: (name: string) => void) {}
  entries(): Iterable<FakeEntry> {
    return this.entriesList
  }
  async create(options: { name: string }): Promise<void> {
    this.created.push(options.name)
    this.onCreate?.(options.name)
  }
  async await(): Promise<void> {
    this.awaited += 1
  }
}

let root: Context | undefined

afterEach(async () => {
  await root?.fiber.dispose()
  root = undefined
})

function withLoader(entriesList: FakeEntry[], onCreate?: (name: string) => void): { ctx: Context; loader: FakeLoader } {
  root = new Context()
  const loader = new FakeLoader(entriesList, onCreate)
  root.reflect.provide('loader', loader)
  return { ctx: root, loader }
}

describe('mountWebPlugins (stubbed loader)', () => {
  it('creates one entry per UI plugin, awaits the tree, and returns the loader view + resolver', async () => {
    const entriesList: FakeEntry[] = []
    const { ctx, loader } = withLoader(entriesList, (name) => {
      entriesList.push({ options: { name }, fiber: {}, disabled: false })
    })
    const mounted = await mountWebPlugins(ctx)
    expect(loader.created).toEqual([...WEB_UI_PLUGINS])
    expect(loader.awaited).toBe(1)
    expect([...mounted.loader.entries()].map(e => e.options.name)).toEqual([...WEB_UI_PLUGINS])
    // The resolver resolves this package's own manifest through real module resolution.
    expect(mounted.resolvePkgJson('@deepseek-ai/dsh-host-runtime')).toMatch(/package\.json$/)
    expect(ctx.baseUrl).toBeDefined()
  })

  it('reuses existing entries (idempotent mount creates no duplicates)', async () => {
    const preexisting: FakeEntry[] = WEB_UI_PLUGINS.map(name => ({ options: { name }, fiber: {}, disabled: false }))
    const { ctx, loader } = withLoader(preexisting)
    await mountWebPlugins(ctx)
    expect(loader.created).toEqual([])
  })

  it('throws listing every fiber-less entry (silent import failure must not drop a UI plugin)', async () => {
    const entriesList: FakeEntry[] = []
    const { ctx } = withLoader(entriesList, (name) => {
      // First two load; the rest stay fiber-less (import failed silently).
      entriesList.push({ options: { name }, fiber: entriesList.length < 2 ? {} : undefined, disabled: false })
    })
    await expect(mountWebPlugins(ctx)).rejects.toThrow(/UI plugin\(s\) failed to load: .*dsh-client-ui-theme/)
  })

  it('skips disabled entries in the fail-loud sweep (disabled is the one valid fiber-less state)', async () => {
    const entriesList: FakeEntry[] = WEB_UI_PLUGINS.map(name => ({ options: { name }, fiber: undefined, disabled: true }))
    const { ctx } = withLoader(entriesList)
    await expect(mountWebPlugins(ctx)).resolves.toBeDefined()
  })

  it('mounts the real Loader when none is present (the ctx.plugin(Loader) branch)', async () => {
    root = new Context()
    // Environment-dependent outcome: with built lib/ the nine imports load
    // and the mount resolves; without them every entry stays fiber-less and
    // the sweep throws its loud list. Either way the branch under test is the
    // Loader auto-mount. Manual try/catch keeps cordis-traced proxies out of
    // expect()'s formatting path (pretty-format probes throw on them).
    // Plain string: the success sentinel and error text share one channel.
    let outcome: string
    try {
      await mountWebPlugins(root)
      outcome = 'resolved'
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error)
    }
    expect(outcome === 'resolved' || /UI plugin\(s\) failed to load/.test(outcome)).toBe(true)
    expect(root.get('loader') !== undefined).toBe(true)
  }, 30_000) // built-env run imports nine real plugin packages through the Loader

  it('keeps a caller-set baseUrl (anchors only when absent)', async () => {
    const entriesList: FakeEntry[] = []
    const { ctx } = withLoader(entriesList, (name) => {
      entriesList.push({ options: { name }, fiber: {}, disabled: false })
    })
    ctx.baseUrl = 'file:///caller/anchor/'
    await mountWebPlugins(ctx)
    expect(ctx.baseUrl).toBe('file:///caller/anchor/')
  })
})
