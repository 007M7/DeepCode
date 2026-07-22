import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { createHostWebPluginRegistry, injectBootManifest } from '../src/index.ts'
import type { LoaderEntryView, WebPluginRegistryDeps } from '../src/index.ts'

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
  return { deps, entries, errors, ctx }
}

describe('createHostWebPluginRegistry', () => {
  it('collects loaded web-declared plugins with url/inject/immediately and client paths', () => {
    const { deps } = makeDeps([
      { name: '@deepseek-ai/dsh-client-connection', pkg: webDecl({ immediately: true }) },
      { name: '@deepseek-ai/dsh-client-ui-layout', pkg: webDecl({ inject: ['@deepseek-ai/dsh-client-runtime'] }) },
      { name: '@deepseek-ai/dsh-agent', pkg: { exports: { '.': './lib/index.js' } } }, // no dshClient: skipped
    ])
    const registry = createHostWebPluginRegistry(deps)
    const rows = registry.snapshot()
    expect(rows).toEqual([
      {
        id: '@deepseek-ai/dsh-client-connection',
        url: '/plugins/@deepseek-ai/dsh-client-connection/client.js',
        inject: [],
        immediately: true,
      },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/plugins/@deepseek-ai/dsh-client-ui-layout/client.js',
        inject: ['@deepseek-ai/dsh-client-runtime'],
      },
    ])
    expect(registry.clientPath('@deepseek-ai/dsh-client-connection')).toMatch(/lib[/\\]client\.js$/)
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
    expect(registry.snapshot()).toEqual([])
    registry.dispose()
  })

  it('fails loud at build time on a dshClient declaration without a "./client" export', () => {
    const { deps } = makeDeps([
      { name: 'broken', pkg: { dshClient: { platform: 'web' }, exports: { '.': './lib/index.js' } } },
    ])
    expect(() => createHostWebPluginRegistry(deps)).toThrow(/declares dshClient but exports no/)
  })

  it('fails loud on malformed declaration fields', () => {
    for (const dshClient of [42, { platform: 7 }, { platform: 'web', inject: 'nope' }, { platform: 'web', immediately: 'yes' }]) {
      const { deps } = makeDeps([{ name: 'bad', pkg: { dshClient, exports: { './client': './lib/client.js' } } }])
      expect(() => createHostWebPluginRegistry(deps)).toThrow(/dshClient/)
    }
  })

  it('rescans on internal/plugin (debounced) and keeps the old table when a rescan fails', async () => {
    const { deps, entries, errors, ctx } = makeDeps([
      { name: 'late-loader', pkg: webDecl(), loaded: false },
    ])
    const registry = createHostWebPluginRegistry(deps)
    expect(registry.snapshot()).toEqual([])

    // Entry finishes loading; a fiber lifecycle event triggers the debounced rescan.
    ;(entries[0] as { fiber?: unknown }).fiber = {}
    ctx.emit('internal/plugin', ctx.fiber)
    ctx.emit('internal/plugin', ctx.fiber) // debounce: two emissions, one rescan
    await Promise.resolve()
    expect(registry.snapshot().map(row => row.id)).toEqual(['late-loader'])

    // A failing rescan reports the error and keeps serving the previous table.
    entries.push({ options: { name: 'ghost' }, fiber: {}, disabled: false })
    ctx.emit('internal/plugin', ctx.fiber)
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(registry.snapshot().map(row => row.id)).toEqual(['late-loader'])

    // After dispose, further fiber events no longer rescan.
    registry.dispose()
    entries.pop()
    ctx.emit('internal/plugin', ctx.fiber)
    await Promise.resolve()
    expect(errors).toHaveLength(1)
  })
})

describe('injectBootManifest', () => {
  it('injects the manifest as the first script inside <head> and escapes </script> breakouts', () => {
    const html = '<html><head><script src="app.js"></script></head><body></body></html>'
    const out = injectBootManifest(html, [{ id: 'x</script><script>alert(1)', url: '/plugins/x/client.js', inject: [] }])
    expect(out.indexOf('window.__DSH_BOOT__')).toBeLessThan(out.indexOf('app.js'))
    expect(out).not.toContain('</script><script>alert(1)')
    expect(out).toContain('\\u003c/script')
  })

  it('prepends when the page has no <head>', () => {
    const out = injectBootManifest('<body>x</body>', [])
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
    expect(registry.snapshot().filter(r => r.id === 'dup-entry')).toHaveLength(1)
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
