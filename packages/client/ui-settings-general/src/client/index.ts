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
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the shell's SlotMap merges (trigger/header/section/item).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ChromeInjected } from './chrome.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import type { GeneralSectionInjected } from './GeneralSection.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import type { WelcomeNoticeInjected } from './WelcomeNotice.tsx'
import { WelcomeNotice } from './WelcomeNotice.tsx'
import { refreshWelcomeIfLoaded, WelcomeNoticeStore } from './welcome-store.ts'
import { en, zh } from './locales.ts'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from '../onboarding-copy.ts'

export type {
  ChromeInjected, CloseLabelProps, HeaderContentProps, TriggerContentProps,
} from './chrome.tsx'
export type {
  GeneralSectionComponentProps, GeneralSectionInjected,
} from './GeneralSection.tsx'
export type { WelcomeNoticeInjected, WelcomeNoticeProps } from './WelcomeNotice.tsx'
export type { WelcomeNoticeState } from './welcome-store.ts'

/** Dictionary namespace owned by this plugin (shell chrome + General copy). */
const NS = 'settings'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration goes through declaration-aware deferral.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the `settings` dictionaries, the chrome content, and the General
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(NS, 'zh', zh),
      ctx.locale.register(NS, 'en', en),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-general: dictionaries')

  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  const welcomeController = new WelcomeNoticeStore(connection.api)
  const useWelcomeSnapshot = bindSnapshotSelector(welcomeController.store)
  const chromeInjected = (): ChromeInjected => ({ t })
  const generalInjected = (): GeneralSectionInjected => ({ t })
  const welcomeInjected = (): WelcomeNoticeInjected => ({
    controller: welcomeController,
    useSnapshot: useWelcomeSnapshot,
    t,
  })

  ctx.effect(() => {
    const refresh = (ns?: string): void => {
      if (ns !== undefined && ns !== WELCOME_NOTICE_SETTINGS_NAMESPACE) return
      refreshWelcomeIfLoaded(welcomeController)
    }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-general: welcome invalidations')

  // All four seats refresh on locale change: re-registration bumps each
  // slot's ledger version, which re-renders the outlets through their own
  // subscriptions (outlet memoization would swallow a parent-only render).
  ctx.effect(() => {
    const trigger = deferRegistration(ctx.slots, 'settings.trigger', TriggerContent, () =>
      ctx.slots.register({ name: 'settings.trigger', inject: chromeInjected }, TriggerContent))
    const header = deferRegistration(ctx.slots, 'settings.header', HeaderContent, () =>
      ctx.slots.register({ name: 'settings.header', inject: chromeInjected }, HeaderContent))
    const close = deferRegistration(ctx.slots, 'settings.close', CloseLabel, () =>
      ctx.slots.register({ name: 'settings.close', inject: chromeInjected }, CloseLabel))
    const general = deferRegistration(ctx.slots, 'settings.section', GeneralSection, () =>
      ctx.slots.register({
        name: 'settings.section',
        id: 'general',
        order: 0,
        label: t('general.nav'),
        children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
        inject: generalInjected,
      }, GeneralSection))
    const welcome = deferRegistration(ctx.slots, 'settings.onboarding', WelcomeNotice, () =>
      ctx.slots.register({
        name: 'settings.onboarding',
        id: 'welcome-notice',
        order: -100,
        inject: welcomeInjected,
      }, WelcomeNotice))
    const offLocale = ctx.on('locale/change', () => {
      trigger.refresh()
      header.refresh()
      close.refresh()
      general.refresh()
      welcome.refresh()
    })
    return () => {
      offLocale()
      trigger.dispose()
      header.dispose()
      close.dispose()
      general.dispose()
      welcome.dispose()
    }
  }, 'ui-settings-general: chrome, section, and onboarding registrations')
}
