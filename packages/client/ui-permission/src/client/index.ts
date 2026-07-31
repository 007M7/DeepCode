/**
 * Permission plugin, browser half. The General-settings row writes the
 * default preset for subsequently created sessions through Settings; the
 * `/permission` popup decoration switches the current session through the
 * host command and its `permissions` projection.
 */
import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandServiceContract, SelectOption } from '@deepseek-ai/dsh-client-ui-command/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-slash/client'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the General item slot and locale service contracts.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PermissionRow } from './PermissionRow.tsx'
import type { PermissionRowInjected } from './PermissionRow.tsx'
import { en, zh } from './locales.ts'
import { displayPresetName } from './presentation.ts'
import {
  PERMISSION_SETTINGS_NS, PermissionSettingsController, refreshPermissionIfLoaded,
} from './settings-store.ts'

export type { PermissionRowInjected, PermissionRowProps } from './PermissionRow.tsx'
export type {
  PermissionDefaultOption, PermissionSettingsState,
} from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['command', 'sessions', 'slots', 'locale', 'connection']

/** Read one session's current permissions projection value (undefined = capability absent). */
function selectOf(session: SessionFace | undefined): PermissionSelect | undefined {
  return session?.projections.faceOf('permissions').getSnapshot() as PermissionSelect | undefined
}

/** Flatten the projection select into popup rows; `custom` is display state, never a target. */
function optionsOf(value: PermissionSelect): SelectOption[] {
  return value.options
    .filter(option => option.value !== 'custom')
    .map(option => ({
      id: option.value,
      label: displayPresetName(option.name),
      ...(option.description !== undefined ? { detail: option.description } : {}),
      ...(option.value === value.currentValue ? { active: true } : {}),
    }))
}

/**
 * Client plugin body: register the /permission popup picker over the
 * permissions projection.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get('command') as CommandServiceContract
  const sessions = ctx.sessions
  const sessionFor = (session: ClientSessionContext): SessionFace | undefined =>
    sessions.binding(session.sessionId)?.session

  ctx.effect(() => ctx.locale.register('settings.permission', { zh, en }), 'ui-permission: settings row dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new PermissionSettingsController(connection.api)
  const useSnapshot = bindSnapshotSelector(controller.store)
  const injected = (): PermissionRowInjected => ({ controller, useSnapshot })

  ctx.effect(() => {
    const refresh = (ns?: string): void => {
      if (ns !== undefined && ns !== PERMISSION_SETTINGS_NS) return
      refreshPermissionIfLoaded(controller)
    }
    const disposers = [
      ctx.on('settings/changed', refresh),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    return () => {
      controller.dispose()
      for (const dispose of disposers) dispose()
    }
  }, 'ui-permission: settings invalidations')

  ctx.effect(() => {
    const row = deferRegistration(ctx.slots, 'settings.general.item', PermissionRow, () =>
      ctx.slots.register({
        name: 'settings.general.item',
        id: 'permission',
        order: -20,
        locale: 'settings.permission',
        inject: injected,
      }, PermissionRow))
    return () => { row.dispose() }
  }, 'ui-permission: General settings row')

  ctx.effect(() => command.decorate({
    name: 'permission',
    // The picker exists exactly while the projection does: a permission-less
    // host serves no key and the bare invocation falls through to the host
    // command (which is absent too — the line simply misses).
    available: session => selectOf(sessionFor(session)) !== undefined,
    ui: {
      kind: 'popupSelect',
      options: (session) => {
        const value = selectOf(sessionFor(session))
        if (value === undefined) throw new Error('permission presets are not available on this host')
        return Promise.resolve(optionsOf(value))
      },
      onSelect: async (option, session) => {
        const live = sessionFor(session)
        if (live === undefined) throw new Error('this session is not materialized yet')
        const result = await live.command(`/permission ${option.id}`)
        if (!result.ok) throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error('the host offers no /permission command')
      },
    },
  }), 'ui-permission: /permission decoration')
}
