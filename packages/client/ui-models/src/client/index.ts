/**
 * Models settings section plugin, browser half. Registers the `models` nav
 * entry into the shell-declared `settings.section` list slot and mounts the
 * provider configuration page: the configurable-provider directory joined
 * with settings namespaces and credential states, edited through the
 * schema-driven form. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ModelsSection } from './ModelsSection.tsx'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import { ModelsSettingsStore } from './store.ts'
import { en, zh } from './locales.ts'

export type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
export type { ModelsSettingsState, ProviderRow } from './store.ts'

/**
 * Refetch the page snapshot only after its first load: an unopened Models
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration goes through declaration-aware deferral.
 */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the Models section once the `settings.section` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings, credentials, or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register('settings.models', 'zh', zh),
      ctx.locale.register('settings.models', 'en', en),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-models: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new ModelsSettingsStore(connection.api)
  const useSnapshot = bindSnapshotSelector(controller.store)
  const t = ctx.locale.bind('settings.models') as ModelsSectionInjected['t']
  const injected = (): ModelsSectionInjected => ({
    controller,
    useSnapshot,
    api: connection.api,
    t,
  })

  // Pushed invalidations converge every open surface without polling: any
  // settings/credentials/topology change refetches once the page loaded.
  ctx.effect(() => {
    const refresh = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('credentials/changed', refresh),
      ctx.on('models/changed', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-models: pushed invalidations')

  ctx.effect(() => {
    const deferred = deferRegistration(ctx.slots, 'settings.section', ModelsSection, () =>
      ctx.slots.register({
        name: 'settings.section',
        id: 'models',
        order: 10,
        label: t('nav'),
        inject: injected,
      }, ModelsSection))
    // Nav labels are registrant-localized: refresh on locale change so the
    // ledger carries fresh text (the version bump re-renders the shell).
    const offLocale = ctx.on('locale/change', () => { deferred.refresh() })
    return () => {
      offLocale()
      deferred.dispose()
    }
  }, 'ui-models: settings section registration')
}
