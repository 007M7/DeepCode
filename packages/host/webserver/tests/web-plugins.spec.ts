import {
  mkdirSync,
  mkdtempSync,
  statSync,
  type PathLike,
  type Stats,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHostWebPluginRegistry, injectBootManifest } from '../src/index.ts'
import type { LoaderEntryView, WebPluginRegistryDeps } from '../src/index.ts'

const fsControl = vi.hoisted(() => ({ failNextStatPath: undefined as string | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (path: PathLike): Stats => {
      if (String(path) === fsControl.failNextStatPath) {
        fsControl.failNextStatPath = undefined
        throw Object.assign(new Error('staged bundle missing'), { code: 'ENOENT' })
      }
      return actual.statSync(path)
    },
  }
})

afterEach(() => {
  fsControl.failNextStatPath = undefined
  vi.useRealTimers()
})

/** Write a fake installed package (package.json + optional client bundle) and return its package.json path. */
function makePkg(root: string, name: string, pkg: Record<string, unknown>, withBundle = true): string {
  const dir = join(root, name.replaceAll('/', '__'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...pkg }))
  if (withBundle) writeFileSync(join(dir, 'lib', 'client.js'), `// bundle of ${name}`)
  return join(dir, 'package.json')
}

const webDecl = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  dshClient: { inject: [], platform: 'web', ...extra },
  exports: { '.': './lib/index.js', './client': './lib/client.js' },
})

interface Fixture {
  deps: WebPluginRegistryDeps
  entries: LoaderEntryView[]
  errors: Error[]
  ctx: Context
  root: string
}

function makeDeps(
  specs: { name: string; pkg: Record<string, unknown>; loaded?: boolean; disabled?: boolean; withBundle?: boolean }[],
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-webplugins-'))
  const paths = new Map<string, string>()
  const entries: LoaderEntryView[] = specs.map((spec) => {
    paths.set(spec.name, makePkg(root, spec.name, spec.pkg, spec.withBundle ?? true))
    return { options: { name: spec.name }, fiber: spec.loaded === false ? undefined : {}, disabled: spec.disabled ?? false }
  })
  const ctx = new Context()
  const errors: Error[] = []
  const deps: WebPluginRegistryDeps = {
    ctx,
    loader: { entries: () => entries },
    resolvePkgJson: (name) => {
      const path = paths.get(name)
      if (path === undefined) throw new Error(`unresolvable ${name}`)
      return path
    },
    onError: err => void errors.push(err),
  }
  return { deps, entries, errors, ctx, root }
}

describe('createHostWebPluginRegistry', () => {
  it('discovers dshClient rows with rev-stamped urls, manifest inject edges, and the declared immediately mark', () => {
    const { deps } = makeDeps([
      { name: '@deepseek-ai/dsh-client-connection', pkg: webDecl({ immediately: true }) },
      { name: '@deepseek-ai/dsh-client-ui-layout', pkg: webDecl({ inject: ['@deepseek-ai/dsh-client-runtime'] }) },
      { name: '@deepseek-ai/dsh-agent', pkg: { exports: { '.': './lib/index.js' } } }, // no dshClient: skipped
    ])
    const registry = createHostWebPluginRegistry(deps)
    const graph = registry.graph()
    expect(graph.rev).toMatch(/^[0-9a-f]{12}$/)
    const connection = graph.entries[0]
    expect(connection?.id).toBe('@deepseek-ai/dsh-client-connection')
    expect(connection?.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(connection?.url).toBe(`/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=${connection?.rev ?? ''}`)
    expect(connection?.immediately).toBe(true)
    const layout = graph.entries[1]
    expect(layout?.id).toBe('@deepseek-ai/dsh-client-ui-layout')
    expect(layout?.inject).toEqual(['@deepseek-ai/dsh-client-runtime'])
    expect(layout?.immediately).toBeUndefined()
    expect(graph.entries).toHaveLength(2)
    expect(registry.clientPath('@deepseek-ai/dsh-client-ui-layout')).toMatch(/lib[/\\]client\.js$/)
    expect(registry.clientPath('@deepseek-ai/dsh-agent')).toBeUndefined()
    registry.dispose()
  })

  it('skips entries that are unloaded, disabled, or declare another platform', () => {
    const { deps } = makeDeps([
      { name: 'not-loaded', pkg: webDecl(), loaded: false },
      { name: 'disabled', pkg: webDecl(), disabled: true },
      { name: 'electron-only', pkg: { dshClient: { platform: 'electron' }, exports: { './client': './lib/client.js' } } },
    ])
    const registry = createHostWebPluginRegistry(deps)
    expect(registry.graph().entries).toEqual([])
    registry.dispose()
  })

  it('fails loud at build time on a dshClient declaration without a "./client" export', () => {
    const { deps } = makeDeps([
      { name: 'broken', pkg: { dshClient: { platform: 'web' }, exports: { '.': './lib/index.js' } } },
    ])
    expect(() => createHostWebPluginRegistry(deps)).toThrow(/declares dshClient but exports no/)
  })

  it('fails loud at build time on a registered bundle that is not built (rev hashing reads the file)', () => {
    const { deps } = makeDeps([{ name: 'unbuilt', pkg: webDecl(), withBundle: false }])
    expect(() => createHostWebPluginRegistry(deps)).toThrow(/ENOENT/)
  })

  it('fails loud on malformed declaration fields', () => {
    for (const dshClient of [42, { platform: 7 }, { platform: 'web', inject: 'nope' }, { platform: 'web', immediately: 'yes' }]) {
      const { deps } = makeDeps([{ name: 'bad', pkg: { dshClient, exports: { './client': './lib/client.js' } } }])
      expect(() => createHostWebPluginRegistry(deps)).toThrow(/dshClient/)
    }
  })

  it('rebuilt(id) re-hashes the bundle, updates the row and graph rev, and keeps the immediately mark', () => {
    const { deps, root } = makeDeps([{ name: 'hot', pkg: webDecl({ immediately: true }) }])
    const registry = createHostWebPluginRegistry(deps)
    const before = registry.graph()
    const beforeRow = before.entries.find(e => e.id === 'hot')
    writeFileSync(join(root, 'hot', 'lib', 'client.js'), '// rebuilt bundle contents')
    const rev = registry.rebuilt('hot')
    expect(rev).toMatch(/^[0-9a-f]{12}$/)
    expect(rev).not.toBe(beforeRow?.rev)
    const after = registry.graph()
    const afterRow = after.entries.find(e => e.id === 'hot')
    expect(afterRow?.rev).toBe(rev)
    expect(afterRow?.url).toBe(`/plugins/hot/client.js?rev=${rev ?? ''}`)
    expect(afterRow?.immediately).toBe(true)
    expect(after.rev).not.toBe(before.rev)
    // Unknown ids are not rebuildable.
    expect(registry.rebuilt('nope')).toBeUndefined()
    registry.dispose()
  })

  it('watch mode: a bundle content change re-hashes the row and notifies onRebuilt; dispose stops the watch', async () => {
    const { deps, root } = makeDeps([{ name: 'watched', pkg: webDecl() }])
    deps.watch = { intervalMs: 20 }
    const registry = createHostWebPluginRegistry(deps)
    const before = registry.graph().entries[0]?.rev
    const rebuilds: { id: string; rev: string }[] = []
    registry.onRebuilt((id, rev) => rebuilds.push({ id, rev }))

    writeFileSync(join(root, 'watched', 'lib', 'client.js'), '// new bundle contents')
    await vi.waitFor(() => { expect(rebuilds).toHaveLength(1) }, { timeout: 5000 })
    expect(rebuilds[0]?.id).toBe('watched')
    expect(rebuilds[0]?.rev).not.toBe(before)
    expect(registry.graph().entries[0]?.rev).toBe(rebuilds[0]?.rev)

    registry.dispose()
    writeFileSync(join(root, 'watched', 'lib', 'client.js'), '// post-dispose contents')
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(rebuilds).toHaveLength(1)
  })

  it('watch mode: a failed rescan baseline preserves the published table and graph', async () => {
    const { deps, entries, errors, ctx, root } = makeDeps([
      { name: 'stable', pkg: webDecl() },
      { name: 'late', pkg: webDecl(), loaded: false },
    ])
    deps.watch = { intervalMs: 1_000 }
    const registry = createHostWebPluginRegistry(deps)
    const before = registry.graph()

    ;(entries[1] as { fiber?: unknown }).fiber = {}
    fsControl.failNextStatPath = join(root, 'late', 'lib', 'client.js')
    ctx.emit('internal/plugin', ctx.fiber)
    await Promise.resolve()

    expect(errors[0]?.message).toContain('staged bundle missing')
    expect(registry.graph()).toBe(before)
    expect(registry.clientPath('late')).toBeUndefined()

    ctx.emit('internal/plugin', ctx.fiber)
    await Promise.resolve()
    expect(registry.graph().entries.map(row => row.id)).toEqual(['stable', 'late'])
    registry.dispose()
  })

  it('watch mode: a missing bundle forces a re-hash when identical metadata reappears', async () => {
    vi.useFakeTimers()
    const { deps, root } = makeDeps([{ name: 'watched', pkg: webDecl() }])
    const bundle = join(root, 'watched', 'lib', 'client.js')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    deps.watch = { intervalMs: 20 }
    const registry = createHostWebPluginRegistry(deps)
    const baseline = statSync(bundle)
    const rebuilds: { id: string; rev: string }[] = []
    registry.onRebuilt((id, rev) => rebuilds.push({ id, rev }))

    unlinkSync(bundle)
    await vi.advanceTimersByTimeAsync(20)
    writeFileSync(bundle, 'x'.repeat(baseline.size))
    utimesSync(bundle, fixedTime, fixedTime)
    const restored = statSync(bundle)
    expect({ mtimeMs: restored.mtimeMs, size: restored.size }).toEqual({
      mtimeMs: baseline.mtimeMs,
      size: baseline.size,
    })
    await vi.advanceTimersByTimeAsync(20)

    expect(rebuilds).toHaveLength(1)
    expect(registry.graph().entries[0]?.rev).toBe(rebuilds[0]?.rev)
    registry.dispose()
  })

  it('rejects a non-positive or non-integer watch interval at build time', () => {
    for (const intervalMs of [0, -5, 1.5]) {
      const { deps } = makeDeps([{ name: 'p', pkg: webDecl() }])
      deps.watch = { intervalMs }
      expect(() => createHostWebPluginRegistry(deps)).toThrow(/watch\.intervalMs/)
    }
  })

  it('rescans on internal/plugin (debounced) and keeps the old graph when a rescan fails', async () => {
    const { deps, entries, errors, ctx } = makeDeps([
      { name: 'late-loader', pkg: webDecl(), loaded: false },
    ])
    const registry = createHostWebPluginRegistry(deps)
    expect(registry.graph().entries).toEqual([])

    // Entry finishes loading; a fiber lifecycle event triggers the debounced rescan.
    ;(entries[0] as { fiber?: unknown }).fiber = {}
    ctx.emit('internal/plugin', ctx.fiber)
    ctx.emit('internal/plugin', ctx.fiber) // debounce: two emissions, one rescan
    await Promise.resolve()
    expect(registry.graph().entries.map(row => row.id)).toEqual(['late-loader'])

    // A failing rescan reports the error and keeps serving the previous graph.
    entries.push({ options: { name: 'ghost' }, fiber: {}, disabled: false })
    ctx.emit('internal/plugin', ctx.fiber)
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(registry.graph().entries.map(row => row.id)).toEqual(['late-loader'])

    // After dispose, further fiber events no longer rescan.
    registry.dispose()
    entries.pop()
    ctx.emit('internal/plugin', ctx.fiber)
    await Promise.resolve()
    expect(errors).toHaveLength(1)
  })
})

describe('injectBootManifest', () => {
  it('injects the graph as the first script inside <head> and escapes </script> breakouts', () => {
    const html = '<html><head><script src="app.js"></script></head><body></body></html>'
    const out = injectBootManifest(html, {
      rev: 'r1',
      entries: [{ id: 'x</script><script>alert(1)', url: '/plugins/x/client.js?rev=r2', rev: 'r2' }],
    })
    expect(out.indexOf('window.__DSH_BOOT__')).toBeLessThan(out.indexOf('app.js'))
    expect(out).not.toContain('</script><script>alert(1)')
    expect(out).toContain('\\u003c/script')
  })

  it('prepends when the page has no <head>', () => {
    const out = injectBootManifest('<body>x</body>', { rev: 'r0', entries: [] })
    expect(out.startsWith('<script>window.__DSH_BOOT__')).toBe(true)
  })
})

describe('clientExportOf shapes (through the registry build)', () => {
  it('accepts the conditional {types, default} export form', () => {
    const { deps } = makeDeps([{
      name: 'conditional',
      pkg: {
        dshClient: { platform: 'web' },
        exports: { './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' } },
      },
    }])
    const registry = createHostWebPluginRegistry(deps)
    expect(registry.clientPath('conditional')).toMatch(/lib[/\\]client\.js$/)
    registry.dispose()
  })

  it('rejects a conditional form without a string default, an array form, and a non-object exports field', () => {
    for (const exportsField of [
      { './client': { types: './x.d.ts' } },
      { './client': ['./a.js'] },
    ]) {
      const { deps } = makeDeps([{ name: 'bad-shape', pkg: { dshClient: { platform: 'web' }, exports: exportsField } }])
      expect(() => createHostWebPluginRegistry(deps)).toThrow(/unsupported shape/)
    }
    // Non-object exports: treated as "no ./client export" → the declares-but-no-bundle throw.
    const { deps } = makeDeps([{ name: 'no-exports', pkg: { dshClient: { platform: 'web' }, exports: './single.js' } }])
    expect(() => createHostWebPluginRegistry(deps)).toThrow(/declares dshClient but exports no/)
  })

  it('skips duplicate loader entries for the same package name (first wins)', () => {
    const { deps, entries } = makeDeps([{ name: 'dup-entry', pkg: webDecl() }])
    const first = entries[0] as LoaderEntryView
    entries.push({ options: { name: 'dup-entry' }, fiber: {}, disabled: false })
    void first
    const registry = createHostWebPluginRegistry(deps)
    expect(registry.graph().entries.filter(r => r.id === 'dup-entry')).toHaveLength(1)
    registry.dispose()
  })

  it('rejects a null conditional form and wraps a non-Error rescan throw', async () => {
    // client: null → the object-form branch's null guard.
    const nulled = makeDeps([{ name: 'null-client', pkg: { dshClient: { platform: 'web' }, exports: { './client': null } } }])
    expect(() => createHostWebPluginRegistry(nulled.deps)).toThrow(/unsupported shape/)

    // Non-Error rescan throw: resolvePkgJson throws a string; onError must get a wrapped Error.
    const { deps, entries, errors, ctx } = makeDeps([{ name: 'ok-one', pkg: webDecl() }])
    const registry = createHostWebPluginRegistry(deps)
    entries.push({ options: { name: 'ghost-two' }, fiber: {}, disabled: false })
    const original = deps.resolvePkgJson
    deps.resolvePkgJson = (name) => {

      if (name === 'ghost-two') throw 'string failure'
      return original(name)
    }
    ctx.emit('internal/plugin', ctx.fiber)
    await Promise.resolve()
    expect(errors[0]).toBeInstanceOf(Error)
    expect(String(errors[0])).toContain('string failure')
    registry.dispose()
  })

})
