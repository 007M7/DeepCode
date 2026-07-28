import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import z from 'schemastery'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsLocal, resolveSpec } from '../src/index.ts'

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-local-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof SettingsLocal>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(SettingsLocal, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('resolveSpec', () => {
  it('defaults watch and debounce when construction bypasses schema normalization', () => {
    const spec = resolveSpec({ path: '/tmp/anywhere/settings.yaml' })
    expect(spec.watch).toBe(true)
    expect(spec.debounceMs).toBe(100)
  })
})

describe('boot and reads', () => {
  it('resolves defaults over an absent file and reports writable', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, 'settings.yaml'), watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema, {
      base: { fontSize: 16 },
    })
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 16 })
    expect(ctx.settings.writable).toBe(true)
  })

  it('reads sections from an existing yaml document', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'ui-theme:\n  theme: light\n')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect(scope.get()).toEqual({ theme: 'light', fontSize: 14 })
  })

  it('reads sections from a json document', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ 'ui-theme': { fontSize: 18 } }))
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 18 })
  })

  it('defaults the file location under the configured harness home', async () => {
    const dir = await tempDir()
    const ctx = await boot({ dshHome: dir, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await scope.update({ theme: 'light' })
    const written = await readFile(join(dir, 'settings.yaml'), 'utf8')
    expect(written).toContain('theme: light')
  })

  it('reads an empty yaml document as no sections', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, '')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
  })

  it('reads an empty json document as no sections', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    await writeFile(path, '')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
  })

  it('fails loud at boot when the document exists but is unreadable', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'ui-theme:\n  theme: light\n')
    await chmod(path, 0o000)
    cleanups.push(() => chmod(path, 0o600))
    await expect(boot({ path, watch: false })).rejects.toThrow(/EACCES|permission/i)
  })

  it('fails loud on an unsupported extension', async () => {
    const dir = await tempDir()
    await expect(boot({ path: join(dir, 'settings.toml'), watch: false }))
      .rejects.toThrow(/not supported/)
  })

  it('fails loud at boot on unparsable yaml', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'ui-theme: [unclosed\n')
    await expect(boot({ path, watch: false })).rejects.toThrow()
  })

  it('fails loud at boot when the root is not a map of sections', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, '- just\n- a list\n')
    await expect(boot({ path, watch: false })).rejects.toThrow(/map of namespace sections/)
  })
})

describe('persist', () => {
  it('writes the merged section, creating the file with owner-only permissions', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await scope.update({ theme: 'light' })

    const written = await readFile(path, 'utf8')
    expect(written).toContain('theme: light')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // Atomic replace leaves no temp artifact behind.
    expect((await readdir(dir)).sort()).toEqual(['settings.yaml'])
  })

  it('preserves comments and unregistered sections across updates', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, [
      '# personal settings',
      'ui-theme:',
      '  theme: light',
      '# owned by a plugin that is not loaded right now',
      'future-plugin:',
      '  keep: me',
      '',
    ].join('\n'))
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await scope.update({ fontSize: 18 })

    const written = await readFile(path, 'utf8')
    expect(written).toContain('# personal settings')
    expect(written).toContain('# owned by a plugin that is not loaded right now')
    expect(written).toContain('keep: me')
    expect(written).toContain('fontSize: 18')
    expect(written).toContain('theme: light')
  })

  it('creates a json document from scratch', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await scope.update({ theme: 'light' })
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(written).toEqual({ 'ui-theme': { theme: 'light' } })
  })

  it('round-trips a json document', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ other: { keep: true } }, null, 2))
    const ctx = await boot({ path, watch: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await scope.update({ theme: 'light' })
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(written).toEqual({ other: { keep: true }, 'ui-theme': { theme: 'light' } })
  })
})

describe('watch', () => {
  it('publishes an external edit to registered scopes', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'ui-theme:\n  theme: light\n')
    const ctx = await boot({ path, debounceMs: 10 })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect(scope.get().theme).toBe('light')

    await writeFile(path, 'ui-theme:\n  theme: dark\n  fontSize: 20\n')
    await vi.waitFor(() => {
      expect(scope.get()).toEqual({ theme: 'dark', fontSize: 20 })
    }, { timeout: 5000 })
  })

  it('keeps the last good document over an invalid edit, then recovers', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'ui-theme:\n  theme: light\n')
    const ctx = await boot({ path, debounceMs: 10 })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)

    await writeFile(path, 'ui-theme: [unclosed\n')
    // The bad edit must never take the live tree down or reset the value.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(scope.get()).toEqual({ theme: 'light', fontSize: 14 })

    await writeFile(path, 'ui-theme:\n  theme: dark\n')
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('dark')
    }, { timeout: 5000 })
  })

  it('treats file removal as an empty document', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'ui-theme:\n  theme: light\n')
    const ctx = await boot({ path, debounceMs: 10 })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)

    await rm(path)
    await vi.waitFor(() => {
      expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
    }, { timeout: 5000 })
  })

  it('does not republish its own persisted write', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot({ path, debounceMs: 10 })
    const events: unknown[] = []
    ctx.on('settings/updated', (ns, _next, _prev, source) => {
      events.push({ ns, source })
    })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await scope.update({ theme: 'light' })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(events).toEqual([{ ns: 'ui-theme', source: 'update' }])
  })
})
