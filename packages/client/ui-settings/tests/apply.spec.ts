/** Settings shell registration: declaration-aware deferral, the injected face, and HMR recovery. */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { GeneralSectionInjected, SettingsRootInjected } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const locale = new LocaleService(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotsService, locale }
}

function declare(slots: SlotsService): () => void {
  return slots.register(
    { name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
}

function injectedOf(slots: SlotsService): SettingsRootInjected {
  const entry = slots.entries('sidebar.settings')[0]!
  return (entry.inject as () => SettingsRootInjected)()
}

describe('ui-settings apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the shell for declarations that arrive before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    expect(before.slots.spec('settings.section')).toEqual({ kind: 'list', scope: 'root' })

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('sidebar.settings')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    // The self-inflicted ledger notifications hit the duplicate guard.
    expect(after.slots.entries('sidebar.settings')).toHaveLength(1)
  })

  it('registers the zh/en shell dictionaries and disposes them with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings')('title')).toBe('设置')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings')('close')).toBe('Close')
    await fiber.dispose()
    // The (ns, locale) seats are free again — the dictionary disposers ran.
    expect(() => b.locale.register('settings', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings', 'en', {})).not.toThrow()
  })

  it('exposes translate over "<ns>:<key>" refs with literal echo for plain text', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = injectedOf(b.slots)
    expect(injected.translate('settings:title')).toBe('设置')
    expect(injected.translate('no colon ref')).toBe('no colon ref')
  })

  it('projects the section ledger into ordered nav rows with option defaults', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = injectedOf(b.slots)
    // The shell ships its own General section (order 0) — the ledger is never
    // empty once apply settles.
    expect(injected.sections()).toEqual([{ id: 'general', order: 0, label: '通用设置' }])
    b.slots.register({ name: 'settings.section', id: 'z', order: 20, label: 'Z' } as never, () => null)
    b.slots.register({ name: 'settings.section', id: 'a', order: 5 } as never, () => null)
    expect(injected.sections()).toEqual([
      { id: 'general', order: 0, label: '通用设置' },
      { id: 'a', order: 5, label: '' },
      { id: 'z', order: 20, label: 'Z' },
    ])
    expect(injected.sectionsVersion()).toBe(b.slots.getVersion('settings.section'))
    const listener = vi.fn()
    const off = injected.subscribeSections(listener)
    b.slots.register({ name: 'settings.section', id: 'b', order: 1, label: 'B' } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalled()
    off()
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(1)
    // Declarer unload: the cascade removes our entry and the slot spec while
    // our local disposer variable goes stale.
    redeclare()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    expect(b.slots.spec('settings.section')).toEqual({ kind: 'list', scope: 'root' })
  })

  it('unregisters the shell and collapses settings.section on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(0)
    expect(b.slots.spec('settings.section')).toBeUndefined()
  })
})

describe('ui-settings general section', () => {
  it('registers the shell-owned General entry and declares the item slot', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(GeneralSection)
    expect(entry.options).toEqual({ id: 'general', order: 0, label: '通用设置' })
    expect(b.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    const injected = (entry.inject as () => GeneralSectionInjected)()
    expect(injected.t('permission.title')).toBe('权限')
  })

  it('re-registers with fresh label text on locale change', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')[0]!.options.label).toBe('General')
    b.locale.setLocale('zh')
    expect(b.slots.entries('settings.section')[0]!.options.label).toBe('通用设置')
  })

  it('locale change while settings.section is undeclared stays a no-op', async () => {
    const b = await bench()
    // No sidebar.settings declaration: the shell never registers, so
    // settings.section is never declared either.
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    b.locale.setLocale('zh')
  })

  it('re-registers after an HMR collapse of the whole chain (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    // Root declarer unload: the cascade removes the shell entry, the
    // settings.section declaration, and the General entry below it.
    redeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
    declare(b.slots)
    // Two deferral hops: the shell re-registers (re-declaring
    // settings.section), then General re-registers into it.
    await Promise.resolve()
    await Promise.resolve()
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(GeneralSection)
    expect(b.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    // The recovered registration still rides the locale path.
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')[0]!.options.label).toBe('General')
    b.locale.setLocale('zh')
  })

  it('removes the General entry and its item declaration on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.spec('settings.general.item')).toBeDefined()
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
  })
})
