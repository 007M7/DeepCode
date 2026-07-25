/**
 * Settings shell plugin, browser half. Occupies the sidebar-owned
 * `sidebar.settings` hole with the trigger row + modal panel, declares the
 * `settings.section` list slot, and projects that ledger into the panel
 * navigation. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context/Events merges (ctx.locale,
// 'locale/change') into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsRootInjected } from './contract/slots.ts'
import { SettingsRoot } from './SettingsRoot.tsx'

export type { SettingsRootComponentProps, SettingsRootInjected, SettingsSectionOwnerProps } from './contract/slots.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-sidebar's apply, whose activation order relative to this one is NOT
 * constrained (dshClient.inject edges are informational); registration goes
 * through declaration-aware deferral.
 */
export const inject = ['slots', 'locale']

/**
 * Register the settings shell into `sidebar.settings` once the declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register('settings', 'zh', { trigger: '设置', title: '设置', close: '关闭' }),
      ctx.locale.register('settings', 'en', { trigger: 'Settings', title: 'Settings', close: 'Close' }),
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
  // Declaration-aware registration; the LEDGER is the has-registered judge
  // (not a local flag): after an HMR collapse re-declares the slot, the
  // cascade already removed our entry, and a stale disposer must not block
  // the re-registration.
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    const tryRegister = (): void => {
      if (ctx.slots.spec('sidebar.settings') === undefined) return
      if (ctx.slots.entries('sidebar.settings').some(e => e.component === SettingsRoot)) return
      dispose = ctx.slots.register({
        name: 'sidebar.settings',
        children: { 'settings.section': { kind: 'list', scope: 'root' } },
        inject: injected,
      }, SettingsRoot)
    }
    const unsubscribe = ctx.slots.subscribe('sidebar.settings', () => { tryRegister() })
    tryRegister()
    return () => {
      unsubscribe()
      dispose?.()
    }
  }, 'ui-settings: shell registration')
}
