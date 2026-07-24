/**
 * mountWebPlugins unit coverage (keyless). The Loader-facing behavior —
 * baseUrl anchoring, entry creation with idempotent reuse, the fiber-less
 * fail-loud sweep, and the resolver seam — is exercised against a stubbed
 * loader service so it runs without built lib/ artifacts. The roster is
 * caller-supplied now (composition moved to apps/cli), so these tests pass
 * their own lists.
 */
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { mountWebPlugins } from '../src/web-plugins.ts'

const ROSTER = [
  '@deepseek-ai/dsh-plugin-a',
  '@deepseek-ai/dsh-plugin-b',
  '@deepseek-ai/dsh-plugin-c',
] as const

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
  it('creates one entry per roster package, awaits the tree, and returns the loader view + resolver', async () => {
    const entriesList: FakeEntry[] = []
    const { ctx, loader } = withLoader(entriesList, (name) => {
      entriesList.push({ options: { name }, fiber: {}, disabled: false })
    })
    const mounted = await mountWebPlugins(ctx, ROSTER, import.meta.url)
    expect(loader.created).toEqual([...ROSTER])
    expect(loader.awaited).toBe(1)
    expect([...mounted.loader.entries()].map(e => e.options.name)).toEqual([...ROSTER])
    // The resolver resolves a real package manifest through real module resolution, anchored at this test file.
    expect(mounted.resolvePkgJson('@deepseek-ai/dsh-host-runtime')).toMatch(/package\.json$/)
    expect(ctx.baseUrl).toBeDefined()
  })

  it('reuses existing entries (idempotent mount creates no duplicates)', async () => {
    const preexisting: FakeEntry[] = ROSTER.map(name => ({ options: { name }, fiber: {}, disabled: false }))
    const { ctx, loader } = withLoader(preexisting)
    await mountWebPlugins(ctx, ROSTER, import.meta.url)
    expect(loader.created).toEqual([])
  })

  it('throws listing every fiber-less entry (silent import failure must not drop a client plugin)', async () => {
    const entriesList: FakeEntry[] = []
    const { ctx } = withLoader(entriesList, (name) => {
      // First one loads; the rest stay fiber-less (import failed silently).
      entriesList.push({ options: { name }, fiber: entriesList.length < 1 ? {} : undefined, disabled: false })
    })
    await expect(mountWebPlugins(ctx, ROSTER, import.meta.url))
      .rejects.toThrow(/client plugin\(s\) failed to load: .*dsh-plugin-c/)
  })

  it('skips disabled entries in the fail-loud sweep (disabled is the one valid fiber-less state)', async () => {
    const entriesList: FakeEntry[] = ROSTER.map(name => ({ options: { name }, fiber: undefined, disabled: true }))
    const { ctx } = withLoader(entriesList)
    await expect(mountWebPlugins(ctx, ROSTER, import.meta.url)).resolves.toBeDefined()
  })

  it('mounts the real Loader when none is present (the ctx.plugin(Loader) branch)', async () => {
    root = new Context()
    // An empty roster keeps this keyless and artifact-free: the branch under
    // test is only the Loader auto-mount.
    await mountWebPlugins(root, [], import.meta.url)
    expect(root.get('loader') !== undefined).toBe(true)
  }, 30_000) // cold-cache import of the real vendored Loader crosses the network-disk 5s default

  it('keeps a caller-set baseUrl (anchors only when absent)', async () => {
    const entriesList: FakeEntry[] = []
    const { ctx } = withLoader(entriesList, (name) => {
      entriesList.push({ options: { name }, fiber: {}, disabled: false })
    })
    ctx.baseUrl = 'file:///caller/anchor/'
    await mountWebPlugins(ctx, ROSTER, import.meta.url)
    expect(ctx.baseUrl).toBe('file:///caller/anchor/')
  })
})
