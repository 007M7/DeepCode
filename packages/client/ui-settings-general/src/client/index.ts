/**
 * General settings section plugin, browser half. Registers the `general`
 * entry into the shell-declared `settings.section` list slot; Language and
 * Appearance are live preferences projected from ctx.locale / ctx.theme
 * through this entry's slot store. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the locale/theme Context+Events merges and snapshot shapes.
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { GeneralSectionInjected } from './contract.ts'
import { createGeneralSettingsStore } from './store.ts'
import { en, zh } from './locales.ts'
import { GeneralSection } from './GeneralSection.tsx'

export type {
  GeneralSectionComponentProps, GeneralSectionInjected, GeneralSettingsState,
  GeneralSettingsStoreHandle, LocaleOptionRow, ThemePreferenceId,
} from './contract.ts'

/** Dictionary namespace owned by this section (also the nav-label reference prefix). */
const NS = 'settings.general'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration goes through declaration-aware deferral.
 */
export const inject = ['slots', 'locale', 'theme']

/**
 * Register the `settings.general` dictionaries and the General section entry
 * once the `settings.section` declaration is on the ledger. The slot store
 * mirrors the locale/theme snapshots: change listeners attach here in apply,
 * write through the bound actions captured at inject time, and the inject
 * factory re-syncs from the getters so no event is lost between registration
 * and first render (the store's revision guard drops stale duplicates).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposeZh = ctx.locale.register(NS, 'zh', zh)
    const disposeEn = ctx.locale.register(NS, 'en', en)
    return () => {
      disposeZh()
      disposeEn()
    }
  }, 'ui-settings-general: dictionaries')

  const store = createGeneralSettingsStore()
  let bound: BoundActions<typeof store> | undefined

  const syncLocale = (snapshot: LocaleSnapshot): void => {
    bound?.syncLocale(
      snapshot.active,
      snapshot.locales.map(l => ({ id: l.id, label: l.label })),
      snapshot.revision,
    )
  }
  const syncTheme = (snapshot: ThemeSnapshot): void => {
    bound?.syncTheme(snapshot.preference, snapshot.revision)
  }
  ctx.on('locale/change', syncLocale)
  ctx.on('theme/change', syncTheme)

  const injected = (actions: BoundActions<typeof store>): GeneralSectionInjected => {
    bound = actions
    syncLocale(ctx.locale.getLocale())
    syncTheme(ctx.theme.getTheme())
    return {
      t: ctx.locale.bind(NS),
      setLocale: (id) => { ctx.locale.setLocale(id) },
      setTheme: (id) => { ctx.theme.setTheme(id) },
    }
  }

  ctx.effect(() => {
    let dispose: (() => void) | undefined
    const register = (): void => {
      dispose = ctx.slots.register({
        name: 'settings.section',
        id: 'general',
        order: 0,
        label: ctx.locale.bind(NS)('nav'),
        store,
        inject: injected,
      }, GeneralSection)
    }
    const tryRegister = (): void => {
      if (ctx.slots.spec('settings.section') === undefined || dispose !== undefined) return
      register()
    }
    // Nav labels are registrant-localized: re-register on locale change so
    // the ledger carries fresh text (the version bump re-renders the shell).
    const offLocale = ctx.on('locale/change', () => {
      if (dispose === undefined) return
      dispose()
      register()
    })
    const unsubscribe = ctx.slots.subscribe('settings.section', () => { tryRegister() })
    tryRegister()
    return () => {
      offLocale()
      unsubscribe()
      dispose?.()
    }
  }, 'ui-settings-general: section registration')
}
