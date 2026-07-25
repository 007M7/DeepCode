/**
 * Settings shell plugin, browser half. Occupies the sidebar-owned
 * `sidebar.settings` hole with the trigger row + modal panel, declares the
 * `settings.section` list slot, projects that ledger into the panel
 * navigation, and ships the first section itself: General, which declares
 * the `settings.general.item` slot that feature plugins contribute
 * preference rows into. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context/Events merges (ctx.locale,
// 'locale/change') into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { GeneralSectionInjected, SettingsRootInjected } from './contract/slots.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { en, zh } from './locales.ts'

export type {
  GeneralSectionComponentProps, GeneralSectionInjected,
  SettingsRootComponentProps, SettingsRootInjected, SettingsSectionOwnerProps,
} from './contract/slots.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-sidebar's apply, whose activation order relative to this one is NOT
 * constrained (dshClient.inject edges are informational); registration goes
 * through declaration-aware deferral.
 */
export const inject = ['slots', 'locale']

/**
 * Register the settings shell into `sidebar.settings` and the shell-owned
 * General section into `settings.section`, each once its declaration is on
 * the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register('settings', 'zh', zh),
      ctx.locale.register('settings', 'en', en),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings: shell copy dictionaries')

  const injected = (): SettingsRootInjected => ({
    translate: (ref) => {
      const colon = ref.indexOf(':')
      if (colon === -1) return ref
      return ctx.locale.bind(ref.slice(0, colon))(ref.slice(colon + 1))
    },
    sectionsVersion: () => ctx.slots.getVersion('settings.section'),
    subscribeSections: listener => ctx.slots.subscribe('settings.section', listener),
    sections: () => ctx.slots.entries('settings.section')
      .map(e => ({
        /* v8 ignore next -- list-slot registration requires id (SlotCore rejects an entry without one) */
        id: e.options.id ?? '',
        order: e.options.order ?? 0,
        label: e.options.label ?? '',
      }))
      .sort((a, b) => a.order - b.order),
  })
  ctx.effect(() => {
    const deferred = deferRegistration(ctx.slots, 'sidebar.settings', SettingsRoot, () =>
      ctx.slots.register({
        name: 'sidebar.settings',
        children: { 'settings.section': { kind: 'list', scope: 'root' } },
        inject: injected,
      }, SettingsRoot))
    return () => { deferred.dispose() }
  }, 'ui-settings: shell registration')

  // The shell's own General section: first page, declares the item slot the
  // feature plugins (locale, ui-theme, …) contribute preference rows into.
  const generalInjected = (): GeneralSectionInjected => ({
    t: ctx.locale.bind('settings'),
  })
  ctx.effect(() => {
    const deferred = deferRegistration(ctx.slots, 'settings.section', GeneralSection, () =>
      ctx.slots.register({
        name: 'settings.section',
        id: 'general',
        order: 0,
        label: ctx.locale.bind('settings')('general.nav'),
        children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
        inject: generalInjected,
      }, GeneralSection))
    // Nav labels are registrant-localized: refresh on locale change so the
    // ledger carries fresh text (the version bump re-renders the shell).
    const offLocale = ctx.on('locale/change', () => { deferred.refresh() })
    return () => {
      offLocale()
      deferred.dispose()
    }
  }, 'ui-settings: general section registration')
}
