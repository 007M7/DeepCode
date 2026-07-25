/** apply wiring: dictionary registration, declaration-aware section entry,
 * snapshot projection into the slot store, locale-driven relabeling, and
 * recovery after an HMR collapse of the declaring entry. */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { ThemeService } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { GeneralSectionInjected } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import type { createGeneralSettingsStore } from '../src/client/store.ts'

const NS = 'settings.general'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  const locale = new LocaleService(ctx)
  const theme = new ThemeService(ctx)
  ctx.provide('locale', locale)
  ctx.provide('theme', theme)
  return { ctx, slots: ctx.get('slots') as SlotsService, locale, theme }
}

/** Stand in for the settings shell: declare the section list slot from root. */
function declareSection(slots: SlotsService): () => void {
  return slots.register(
    { name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

/** Mirror the framework's inject choreography: bake a real instance from the
 * declared handle and hand its actions to the entry's inject factory. */
function faceOf(slots: SlotsService) {
  const entry = slots.entries('settings.section')[0]!
  const handle = entry.store as ReturnType<typeof createGeneralSettingsStore>
  const instance = handle.create()
  const face = (entry.inject as unknown as (a: typeof instance.actions) => GeneralSectionInjected)(instance.actions)
  return { entry, instance, face }
}

describe('ui-settings-general apply', () => {
  it('declares the slot, locale, and theme services', () => {
    expect(inject).toEqual(['slots', 'locale', 'theme'])
  })

  it('registers dictionaries and the section entry for declarations before or after apply', async () => {
    const before = await bench()
    declareSection(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(GeneralSection)
    expect(entry.options).toMatchObject({ id: 'general', order: 0, label: '通用设置' })
    expect(before.locale.bind(NS)('nav')).toBe('通用设置')

    const after = await bench()
    const fiber = after.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    declareSection(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')[0]!.component).toBe(GeneralSection)
    // Teardown without a live registration exercises the undefined-disposer arm.
    await fiber.dispose()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
  })

  it('projects service snapshots into the store and routes face writes back', async () => {
    const b = await bench()
    declareSection(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Events ahead of any inject hit the unbound-actions arm without a store.
    b.theme.setTheme('dark')

    const { instance, face } = faceOf(b.slots)
    // The inject-time re-sync sealed the init window: both mirrors are current.
    expect(instance.getSnapshot().localeActive).toBe('zh')
    expect(instance.getSnapshot().localeOptions.map(l => l.id)).toEqual(['zh', 'en'])
    expect(instance.getSnapshot().themePreference).toBe('dark')
    expect(face.t('nav')).toBe('通用设置')

    face.setLocale('en')
    expect(b.locale.getLocale().active).toBe('en')
    expect(instance.getSnapshot().localeActive).toBe('en')
    expect(face.t('nav')).toBe('General')

    face.setTheme('system')
    expect(b.theme.getTheme().preference).toBe('system')
    expect(instance.getSnapshot().themePreference).toBe('system')
  })

  it('re-registers with a fresh ledger label when the locale changes', async () => {
    const b = await bench()
    declareSection(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')[0]!.options.label).toBe('通用设置')
    b.locale.setLocale('en')
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.options.label).toBe('General')
    expect(entry.component).toBe(GeneralSection)
  })

  it('recovers after an HMR collapse of the declaring entry (stale disposer must not block)', async () => {
    const b = await bench()
    const host = declareSection(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)

    // Collapse: the declarer dies, the cascade removes our entry while the
    // apply closure still holds its (now stale) disposer.
    host()
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    // A locale change inside the collapsed window must stay quiet.
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    // Redeclaration restores the entry — with the current locale's label.
    declareSection(b.slots)
    await Promise.resolve()
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(GeneralSection)
    expect(entry.options.label).toBe('General')
  })

  it('removes the entry and the dictionaries on teardown', async () => {
    const b = await bench()
    declareSection(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    // Dictionary disposal: translation falls back to the bare key.
    expect(b.locale.bind(NS)('nav')).toBe('nav')
  })
})
