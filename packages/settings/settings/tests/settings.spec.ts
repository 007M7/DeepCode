import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import z from 'schemastery'
import { settingsNamespace, type SettingsScope, type SettingsUpdateSource } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

interface NestedConfig {
  retry: { attempts: number; delayMs: number }
  tags: string[]
}

const NestedSchema: z<NestedConfig> = z.object({
  retry: z.object({
    attempts: z.number().default(2),
    delayMs: z.number().default(100),
  }),
  tags: z.array(z.string()).default(['default']),
})

async function boot(options?: ConstructorParameters<typeof MemorySettings>[1]) {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, options)
  const provider = ctx.get('settings') as MemorySettings
  return { ctx, provider }
}

/** Record every settings/updated emission. */
function recordUpdates(ctx: Context) {
  const events: Array<{ ns: string; next: unknown; prev: unknown; source: SettingsUpdateSource }> = []
  ctx.on('settings/updated', (ns, next, prev, source) => {
    events.push({ ns, next, prev, source })
  })
  return events
}

describe('settingsNamespace', () => {
  it('brands lowercase kebab-case names', () => {
    expect(settingsNamespace('ui-theme')).toBe('ui-theme')
  })

  it.each(['', 'UI', '9lives', 'a_b', '-lead'])('rejects %j', (value) => {
    expect(() => settingsNamespace(value)).toThrow(TypeError)
  })
})

describe('registration', () => {
  it('resolves schema defaults, then composition base, then the user layer', async () => {
    const { ctx } = await boot({ doc: { 'ui-theme': { theme: 'light' } } })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema, {
      base: { fontSize: 16 },
    })
    // theme: user layer wins; fontSize: base wins over the schema default.
    expect(scope.get()).toEqual({ theme: 'light', fontSize: 16 })
  })

  it('rejects a duplicate namespace loud', async () => {
    const { ctx } = await boot()
    ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect(() => ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema))
      .toThrow(/already registered/)
  })

  it('fails registration when the stored section is invalid for the schema', async () => {
    const { ctx } = await boot({ doc: { 'ui-theme': { fontSize: 'big' } } })
    expect(() => ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)).toThrow()
  })

  it('fails registration when the stored section is not an object', async () => {
    const { ctx } = await boot({ doc: { 'ui-theme': 'dark' } })
    expect(() => ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema))
      .toThrow(/must be an object/)
  })

  it('describes registered namespaces with schema JSON, value, and applies', async () => {
    const { ctx } = await boot()
    ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    ctx.settings.register(settingsNamespace('workspace'), NestedSchema, { applies: 'restart' })
    const descriptors = ctx.settings.describe()
    expect(descriptors.map(entry => [entry.ns, entry.applies])).toEqual([
      ['ui-theme', 'live'],
      ['workspace', 'restart'],
    ])
    expect(descriptors[0]!.value).toEqual({ theme: 'dark', fontSize: 14 })
    // schemastery's canonical wire form: a { uid, refs } envelope whose root ref
    // is the object schema — the shape schema-driven form UIs reconstruct from.
    const serialized = descriptors[0]!.schema as { uid: number; refs: Record<string, { type: string }> }
    expect(serialized.refs[String(serialized.uid)]?.type).toBe('object')
  })

  it('reads undefined for an unregistered namespace', async () => {
    const { ctx } = await boot()
    expect(ctx.settings.get(settingsNamespace('missing'))).toBeUndefined()
  })

  it('hands out frozen resolved values', async () => {
    const { ctx } = await boot({ doc: { workspace: { retry: { attempts: 5 } } } })
    const scope = ctx.settings.register(settingsNamespace('workspace'), NestedSchema)
    const value = scope.get()
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.retry)).toBe(true)
    expect(() => { (value.retry as { attempts: number }).attempts = 0 }).toThrow(TypeError)
  })

  it('removes the namespace and its observers when the registrant fiber disposes', async () => {
    const { ctx, provider } = await boot()
    const seen: unknown[] = []
    let scope: SettingsScope<ThemeConfig> | undefined
    const fiber = ctx.plugin({
      inject: ['settings'],
      apply: (child: Context) => {
        scope = child.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
        scope.watch(next => seen.push(next))
      },
    })
    await fiber
    expect(ctx.settings.get(settingsNamespace('ui-theme'))).toEqual({ theme: 'dark', fontSize: 14 })

    await fiber.dispose()
    expect(ctx.settings.get(settingsNamespace('ui-theme'))).toBeUndefined()
    expect(ctx.settings.describe()).toEqual([])
    provider.pushExternal({ 'ui-theme': { theme: 'light' } })
    expect(seen).toEqual([])

    // The namespace is free again, and re-registration resolves the user layer
    // that kept living in storage while nobody owned the namespace.
    const again = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    expect(again.get()).toEqual({ theme: 'light', fontSize: 14 })
  })
})

describe('update', () => {
  it('persists the merged user section without baking in the base layer', async () => {
    const { ctx, provider } = await boot({ doc: { 'ui-theme': { theme: 'light' } } })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema, {
      base: { fontSize: 16 },
    })
    await scope.update({ theme: 'dark' })
    expect(provider.persisted).toEqual([
      { ns: 'ui-theme', section: { theme: 'dark' } },
    ])
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 16 })
  })

  it('deep-merges nested objects and replaces arrays wholesale', async () => {
    const { ctx, provider } = await boot({
      doc: { workspace: { retry: { attempts: 5, delayMs: 300 }, tags: ['a', 'b'] } },
    })
    const scope = ctx.settings.register(settingsNamespace('workspace'), NestedSchema)
    await scope.update({ retry: { attempts: 7 }, tags: ['c'] })
    expect(provider.persisted[0]!.section).toEqual({
      retry: { attempts: 7, delayMs: 300 },
      tags: ['c'],
    })
    expect(scope.get()).toEqual({ retry: { attempts: 7, delayMs: 300 }, tags: ['c'] })
  })

  it('commits, notifies watchers, and emits with source update', async () => {
    const { ctx } = await boot()
    const events = recordUpdates(ctx)
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    const watcher = vi.fn()
    scope.watch(watcher)
    await scope.update({ theme: 'light' })
    expect(watcher).toHaveBeenCalledWith(
      { theme: 'light', fontSize: 14 },
      { theme: 'dark', fontSize: 14 },
    )
    expect(events).toEqual([{
      ns: 'ui-theme',
      next: { theme: 'light', fontSize: 14 },
      prev: { theme: 'dark', fontSize: 14 },
      source: 'update',
    }])
  })

  it('rejects an invalid patch before persisting anything', async () => {
    const { ctx, provider } = await boot()
    const events = recordUpdates(ctx)
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await expect(scope.update({ fontSize: 'big' })).rejects.toThrow()
    expect(provider.persisted).toEqual([])
    expect(events).toEqual([])
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
  })

  it('ignores explicit undefined entries so a sparse patch cannot erase keys', async () => {
    const { ctx, provider } = await boot({ doc: { 'ui-theme': { theme: 'light' } } })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await scope.update({ theme: undefined, fontSize: 18 })
    expect(provider.persisted[0]!.section).toEqual({ theme: 'light', fontSize: 18 })
    expect(scope.get()).toEqual({ theme: 'light', fontSize: 18 })
  })

  it('rejects a non-object patch', async () => {
    const { ctx } = await boot()
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await expect(scope.update([1])).rejects.toThrow(TypeError)
    await expect(scope.update(new Date() as unknown as object)).rejects.toThrow(TypeError)
  })

  it('accepts a null-prototype patch object', async () => {
    const { ctx } = await boot()
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    const patch: { fontSize?: number } = Object.create(null) as { fontSize?: number }
    patch.fontSize = 18
    await scope.update(patch)
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 18 })
  })

  it('rejects an unregistered namespace', async () => {
    const { ctx } = await boot()
    await expect(ctx.settings.update(settingsNamespace('missing'), {}))
      .rejects.toThrow(/not registered/)
  })

  it('rejects on a read-only provider before reaching persist', async () => {
    const { ctx, provider } = await boot({ writable: false })
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    await expect(scope.update({ theme: 'light' })).rejects.toThrow(/read-only/)
    expect(provider.persisted).toEqual([])
  })
})

describe('publish', () => {
  it('notifies watchers of an external change with source provider', async () => {
    const { ctx, provider } = await boot()
    const events = recordUpdates(ctx)
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    const watcher = vi.fn()
    scope.watch(watcher)
    provider.pushExternal({ 'ui-theme': { theme: 'light' } })
    expect(watcher).toHaveBeenCalledWith(
      { theme: 'light', fontSize: 14 },
      { theme: 'dark', fontSize: 14 },
    )
    expect(events[0]!.source).toBe('provider')
  })

  it('stays silent when the resolved value is deep-equal', async () => {
    const { ctx, provider } = await boot({ doc: { 'ui-theme': { theme: 'light' } } })
    const events = recordUpdates(ctx)
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    const watcher = vi.fn()
    scope.watch(watcher)
    provider.pushExternal({ 'ui-theme': { theme: 'light' } })
    expect(watcher).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('keeps the last good value for an invalid section while other namespaces commit', async () => {
    const { ctx, provider } = await boot()
    const events = recordUpdates(ctx)
    const theme = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    const workspace = ctx.settings.register(settingsNamespace('workspace'), NestedSchema)
    provider.pushExternal({
      'ui-theme': { fontSize: 'broken' },
      workspace: { retry: { attempts: 9 } },
    })
    expect(theme.get()).toEqual({ theme: 'dark', fontSize: 14 })
    expect(workspace.get()).toEqual({ retry: { attempts: 9, delayMs: 100 }, tags: ['default'] })
    expect(events.map(event => event.ns)).toEqual(['workspace'])
  })

  it('recovers from a bad section once storage turns valid again', async () => {
    const { ctx, provider } = await boot()
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    provider.pushExternal({ 'ui-theme': { fontSize: 'broken' } })
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
    provider.pushExternal({ 'ui-theme': { fontSize: 18 } })
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 18 })
  })
})

describe('watch', () => {
  it('stops after its disposer runs', async () => {
    const { ctx, provider } = await boot()
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    const watcher = vi.fn()
    const dispose = scope.watch(watcher)
    dispose()
    provider.pushExternal({ 'ui-theme': { theme: 'light' } })
    expect(watcher).not.toHaveBeenCalled()
  })

  it('contains a throwing watcher without blocking the commit or other watchers', async () => {
    const { ctx, provider } = await boot()
    const events = recordUpdates(ctx)
    const scope = ctx.settings.register(settingsNamespace('ui-theme'), ThemeSchema)
    scope.watch(() => { throw new Error('watcher boom') })
    const second = vi.fn()
    scope.watch(second)
    provider.pushExternal({ 'ui-theme': { theme: 'light' } })
    expect(second).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
    expect(scope.get()).toEqual({ theme: 'light', fontSize: 14 })
  })
})
