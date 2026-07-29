/**
 * Permission preset plugin, browser half — a popupSelect DECORATION hung on
 * the host `/permission` command: one flat list of presets, current value
 * marked active, a pick executes the switch. The decoration owns only the
 * bare invocation; the host command keeps its catalog row, the argued path
 * (`/permission <preset>` still switches directly), and the lifecycle
 * logging. Options and the active mark read the session's `permissions`
 * projection (the same host-computed select the composer chip renders); a
 * pick submits the `/permission <preset>` command line, so both surfaces
 * write through one path and the pushed projection frame is the one
 * confirmation.
 */
import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandServiceContract, SelectOption } from '@deepseek-ai/dsh-client-ui-command/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-slash/client'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission/client'

/** Required services (cordis fiber inject). */
export const inject = ['command', 'sessions']

/** Read one session's current permissions projection value (undefined = capability absent). */
function selectOf(session: SessionFace | undefined): PermissionSelect | undefined {
  return session?.projections.faceOf('permissions').getSnapshot() as PermissionSelect | undefined
}

/**
 * Display transform twin of the composer chip's (ui-conversation
 * PermissionSelect): kebab-case machine names render as title-case labels
 * (`workspace-write` → `Workspace Write`) so both permission surfaces show
 * the same text; non-kebab host-configured names pass through.
 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** Flatten the projection select into popup rows; `custom` is display state, never a target. */
function optionsOf(value: PermissionSelect): SelectOption[] {
  return value.options
    .filter(option => option.value !== 'custom')
    .map(option => ({
      id: option.value,
      label: displayName(option.name),
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
