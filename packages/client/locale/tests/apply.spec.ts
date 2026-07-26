/** locale apply wiring: service + dictionaries provision, declaration-aware
 * Language row registration, snapshot projection into the row store, and
 * recovery after an HMR collapse of the declaring entry. */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject, SETTINGS_NS } from '@deepseek-ai/dsh-client-locale/client'
import type { LanguageRowInjected, LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { LanguageRow } from '../src/client/LanguageRow.tsx'
import type { createLanguageRowStore } from '../src/client/settings-store.ts'

const SLOT = 'settings.general.item'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotsService).await()
  return { ctx, slots: ctx.get('slots') as SlotsService }
}

/** Stand in for the settings shell: declare the General item slot from root. */
function declareItems(slots: SlotsService): () => void {
  return slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

/** Mirror the framework's inject choreography: bake a real instance from the
 * declared handle and hand its actions to the entry's inject factory. */
function faceOf(slots: SlotsService) {
  const entry = slots.entries(SLOT).find(e => e.component === LanguageRow)!
  const handle = entry.store as ReturnType<typeof createLanguageRowStore>
  const instance = handle.create()
  const face = (entry.inject as unknown as (a: typeof instance.actions) => LanguageRowInjected)(instance.actions)
  return { entry, instance, face }
}

describe('locale apply', () => {
  it('declares the slot service', () => {
    expect(inject).toEqual(['slots'])
  })

  it('provides the service with base + settings dictionaries and registers the row (declaration before or after apply)', async () => {
    const before = await bench()
    declareItems(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = before.ctx.get('locale') as LocaleService
    // Base dictionaries are registered: the (ns, locale) seats are occupied.
    expect(() => locale.register('common', 'zh', {})).toThrow('already has locale')
    expect(() => locale.register('common', 'en', {})).toThrow('already has locale')
    expect(locale.bind(SETTINGS_NS)('language.title')).toBe('语言')
    const entry = before.slots.entries(SLOT).find(e => e.component === LanguageRow)!
    expect(entry.options).toMatchObject({ id: 'language', order: 0 })

    const after = await bench()
    const fiber = after.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(after.slots.entries(SLOT)).toHaveLength(0)
    declareItems(after.slots)
    await Promise.resolve()
    expect(after.slots.entries(SLOT).some(e => e.component === LanguageRow)).toBe(true)
  })

  it('projects service snapshots into the row store and routes face writes back', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = b.ctx.get('locale') as LocaleService
    // An event ahead of any inject hits the unbound-actions arm.
    locale.setLocale('en')

    const { instance, face } = faceOf(b.slots)
    // The inject-time re-sync sealed the init window: the mirror is current.
    expect(instance.getSnapshot().active).toBe('en')
    expect(instance.getSnapshot().options.map(o => o.id)).toEqual(['zh', 'en'])
    expect(face.t('language.title')).toBe('Language')

    face.setLocale('zh')
    expect(locale.getLocale().active).toBe('zh')
    expect(instance.getSnapshot().active).toBe('zh')
    expect(face.t('language.title')).toBe('语言')
  })

  it('recovers after an HMR collapse of the declaring entry (stale disposer must not block)', async () => {
    const b = await bench()
    const host = declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries(SLOT)).toHaveLength(1)

    // Collapse: the declarer dies, the cascade removes our entry while the
    // apply closure still holds its (now stale) disposer.
    host()
    expect(b.slots.entries(SLOT)).toHaveLength(0)

    declareItems(b.slots)
    await Promise.resolve()
    expect(b.slots.entries(SLOT).some(e => e.component === LanguageRow)).toBe(true)
  })

  it('teardown removes the row; teardown without a declaration is quiet', async () => {
    const b = await bench()
    declareItems(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(SLOT)).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)

    // Never-declared bench: the effect disposer's dispose arm stays undefined.
    const quiet = await bench()
    const f2 = quiet.ctx.plugin({ inject: [...inject], apply })
    await f2.await()
    await f2.dispose()
    expect(quiet.slots.entries(SLOT)).toHaveLength(0)
  })
})
