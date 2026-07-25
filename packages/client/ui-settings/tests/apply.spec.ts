/** Settings shell registration: declaration-aware deferral, the injected face, and HMR recovery. */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsRootInjected } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'

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
    expect(injected.sections()).toEqual([])
    b.slots.register({ name: 'settings.section', id: 'z', order: 20, label: 'Z' } as never, () => null)
    b.slots.register({ name: 'settings.section', id: 'a' } as never, () => null)
    expect(injected.sections()).toEqual([
      { id: 'a', order: 0, label: '' },
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
