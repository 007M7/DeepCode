/**
 * Settings shell plugin, browser half. A pure composition face: occupies the
 * sidebar-owned `sidebar.settings` hole with the trigger chrome + modal
 * panel, declares the `settings.trigger` / `settings.header` /
 * `settings.section` slots, and projects the section ledger into the panel
 * navigation. The shell ships no copy and reads no locale state — all text
 * arrives from registrants (ui-settings-general owns the chrome and General
 * content; features own their rows and sections). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsRootInjected, SettingsSectionRow } from './contract/slots.ts'
import { SettingsRoot } from './SettingsRoot.tsx'

export type {
  SettingsHeaderOwnerProps, SettingsRootComponentProps, SettingsRootInjected,
  SettingsSectionOwnerProps, SettingsSectionRow, SettingsTriggerOwnerProps,
} from './contract/slots.ts'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-sidebar's apply, whose activation order relative to this one is NOT
 * constrained (dshClient.inject edges are informational); registration goes
 * through declaration-aware deferral.
 */
export const inject = ['slots']

/**
 * Register the settings shell into `sidebar.settings` once the declaration is
 * on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Ledger → nav-row projection as an observable source (uSES contract:
  // getSnapshot returns the cached rows until the ledger version moves).
  let rowsVersion = -1
  let rows: readonly SettingsSectionRow[] = []
  const injected = (): SettingsRootInjected => ({
    hooks: {
      sections: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          if (version !== rowsVersion) {
            rowsVersion = version
            rows = ctx.slots.entries('settings.section')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id (SlotCore rejects an entry without one) */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
                label: e.options.label ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return rows
        },
        subscribe: listener => ctx.slots.subscribe('settings.section', listener),
      },
    },
  })
  ctx.effect(() => {
    const deferred = deferRegistration(ctx.slots, 'sidebar.settings', SettingsRoot, () =>
      ctx.slots.register({
        name: 'sidebar.settings',
        children: {
          'settings.trigger': { kind: 'single', scope: 'root' },
          'settings.header': { kind: 'single', scope: 'root' },
          'settings.close': { kind: 'single', scope: 'root' },
          'settings.section': { kind: 'list', scope: 'root' },
        },
        inject: injected,
      }, SettingsRoot))
    return () => { deferred.dispose() }
  }, 'ui-settings: shell registration')
}
