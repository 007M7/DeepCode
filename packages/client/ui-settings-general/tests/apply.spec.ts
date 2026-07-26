/** Ownerless-copy registrations: the four seats, the dictionaries, locale refresh, and HMR recovery. */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { GeneralSectionInjected } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'

/** The four seats this plugin fills (slot name → expected component). */
const SEATS = [
  ['settings.trigger', TriggerContent],
  ['settings.header', HeaderContent],
  ['settings.close', CloseLabel],
  ['settings.section', GeneralSection],
] as const

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const locale = new LocaleService(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotsService, locale }
}

/** Declare the shell's four child slots the way ui-settings' entry does. */
function declare(slots: SlotsService): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.trigger': { kind: 'single', scope: 'root' },
        'settings.header': { kind: 'single', scope: 'root' },
        'settings.close': { kind: 'single', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

function generalEntry(slots: SlotsService) {
  return slots.entries('settings.section').find(e => e.component === GeneralSection)
}

describe('ui-settings-general apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('fills all four seats for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    for (const [name, component] of SEATS) {
      expect(before.slots.entries(name)[0]!.component).toBe(component)
    }
    const entry = generalEntry(before.slots)!
    expect(entry.options).toEqual({ id: 'general', order: 0, label: '通用设置' })
    expect(before.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    const injected = (entry.inject as unknown as () => GeneralSectionInjected)()
    expect(injected.t('permission.title')).toBe('权限')
    // The chrome seats share one inject face: the settings-ns translate.
    const chrome = (before.slots.entries('settings.trigger')[0]!.inject as unknown as () => GeneralSectionInjected)()
    expect(chrome.t('trigger')).toBe('设置')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const [name] of SEATS) expect(after.slots.entries(name)).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    for (const [name, component] of SEATS) {
      expect(after.slots.entries(name)[0]!.component).toBe(component)
      // The self-inflicted ledger notifications hit the duplicate guard.
      expect(after.slots.entries(name)).toHaveLength(1)
    }
  })

  it('registers the zh/en settings dictionaries and frees the seats on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings')('title')).toBe('设置')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings')('close')).toBe('Close')
    b.locale.setLocale('zh')
    await fiber.dispose()
    // The (ns, locale) seats are free again — the dictionary disposers ran.
    expect(() => b.locale.register('settings', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings', 'en', {})).not.toThrow()
  })

  it('refreshes all four seats on locale change with fresh General label text', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const zhVersions = SEATS.map(([name]) => b.slots.getVersion(name))
    b.locale.setLocale('en')
    // Every seat re-registered (version moved) and the label re-resolved.
    SEATS.forEach(([name], i) => {
      expect(b.slots.getVersion(name)).toBeGreaterThan(zhVersions[i]!)
      expect(b.slots.entries(name)).toHaveLength(1)
    })
    expect(generalEntry(b.slots)!.options.label).toBe('General')
    b.locale.setLocale('zh')
    expect(generalEntry(b.slots)!.options.label).toBe('通用设置')
  })

  it('locale change while the slots are undeclared stays a no-op', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    for (const [name] of SEATS) expect(b.slots.entries(name)).toHaveLength(0)
    b.locale.setLocale('zh')
  })

  it('re-registers after an HMR collapse of the declaring chain (stale disposers must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Declarer unload: the cascade removes every seat entry and the item
    // declaration while our local disposers go stale.
    redeclare()
    for (const [name] of SEATS) expect(b.slots.entries(name)).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
    declare(b.slots)
    await Promise.resolve()
    for (const [name, component] of SEATS) {
      expect(b.slots.entries(name)[0]!.component).toBe(component)
    }
    expect(b.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    // The recovered registrations still ride the locale path.
    b.locale.setLocale('en')
    expect(generalEntry(b.slots)!.options.label).toBe('General')
    b.locale.setLocale('zh')
  })

  it('removes every seat and the item declaration on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.spec('settings.general.item')).toBeDefined()
    await fiber.dispose()
    for (const [name] of SEATS) expect(b.slots.entries(name)).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
  })
})
