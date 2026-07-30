/**
 * Settings ownerless-copy plugin, browser half: registers everything on the
 * Settings surface that belongs to no single feature — the trigger/header
 * chrome content, the General section (skeleton rows + the
 * `settings.general.item` slot declaration), and the `settings`
 * dictionaries. Feature-owned rows and sections stay with their features.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the shell's SlotMap merges (trigger/header/section/item).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale and the 'settings.general.item' SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { en, zh, type SettingsKey } from './locales.ts'

export type {
  CloseLabelProps, HeaderContentProps, TriggerContentProps,
} from './chrome.tsx'
export type { GeneralSectionComponentProps } from './GeneralSection.tsx'
export type { SettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shell chrome + shell-owned General section copy. */
    settings: SettingsKey
  }
}

/** Dictionary namespace owned by this plugin (shell chrome + General copy). */
const NS = 'settings'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration goes through declaration-aware deferral.
 */
export const inject = ['slots', 'locale']

/**
 * Register the `settings` dictionaries, the chrome content, and the General
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-general: dictionaries')

  // Copy freshness is framework-owned: components read the standard `t`
  // seat, and the nav label is a thunk the owner resolves per render — no
  // locale/change re-registration wiring.
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    const trigger = deferRegistration(ctx.slots, 'settings.trigger', TriggerContent, () =>
      ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
    const header = deferRegistration(ctx.slots, 'settings.header', HeaderContent, () =>
      ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
    const close = deferRegistration(ctx.slots, 'settings.close', CloseLabel, () =>
      ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))
    const general = deferRegistration(ctx.slots, 'settings.section', GeneralSection, () =>
      ctx.slots.register({
        name: 'settings.section',
        id: 'general',
        order: 0,
        label: () => t('general.nav'),
        locale: NS,
        children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
      }, GeneralSection))
    return () => {
      trigger.dispose()
      header.dispose()
      close.dispose()
      general.dispose()
    }
  }, 'ui-settings-general: chrome and section registrations')
}
