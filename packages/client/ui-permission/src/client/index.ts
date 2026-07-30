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
 * confirmation. The Full access row carries the same explicit risk gate as
 * the composer chip; the shared popup shell owns the modal mechanics.
 */
import type { ClientContext, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandServiceContract, SelectOption } from '@deepseek-ai/dsh-client-ui-command/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-slash/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PermissionSelect } from '@deepseek-ai/dsh-permission/client'

/** Required services (cordis fiber inject). */
export const inject = ['command', 'sessions', 'locale']

const FULL_ACCESS = 'danger-full-access'
const ACCESS_NS = 'permission.access'

/** Read one session's current permissions projection value (undefined = capability absent). */
function selectOf(session: SessionFace | undefined): PermissionSelect | undefined {
  return session?.projections.faceOf('permissions').getSnapshot() as PermissionSelect | undefined
}

/**
 * Display transform twin of the composer chip's (ui-conversation
 * PermissionSelect): kebab-case machine names render as title-case labels
 * (`workspace-write` → `Workspace Write`); non-kebab host-configured names
 * pass through. Full access intentionally uses the product label rather than
 * a title-cased machine value; its warning body remains locale-aware.
 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** Flatten the projection select into popup rows; `custom` is display state, never a target. */
function optionsOf(value: PermissionSelect, t: (key: string) => string): SelectOption[] {
  return value.options
    .filter(option => option.value !== 'custom')
    .map(option => ({
      id: option.value,
      label: option.value === FULL_ACCESS ? 'Full access' : displayName(option.name),
      ...(option.description !== undefined ? { detail: option.description } : {}),
      ...(option.value === value.currentValue ? { active: true } : {}),
      ...(option.value === FULL_ACCESS
        ? {
          confirmation: {
            title: t('confirm.title'),
            description: t('confirm.description'),
            acknowledgeLabel: t('confirm.acknowledge'),
            cancelLabel: t('confirm.cancel'),
            confirmLabel: t('confirm.enable'),
          },
        }
        : {}),
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
  // This optional bundle and ui-conversation can load independently, so each
  // owns the same safety copy under its own locale namespace.
  /* jscpd:ignore-start */
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(ACCESS_NS, 'zh', {
        'confirm.title': '确认启用 Full access？',
        'confirm.description': '启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
        'confirm.acknowledge': '我已了解风险，并愿意继续',
        'confirm.cancel': '取消',
        'confirm.enable': '启用 Full access',
      }),
      ctx.locale.register(ACCESS_NS, 'en', {
        'confirm.title': 'Enable Full access?',
        'confirm.description': 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
        'confirm.acknowledge': 'I understand the risks and want to continue',
        'confirm.cancel': 'Cancel',
        'confirm.enable': 'Enable Full access',
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-permission: Full access confirmation dictionaries')
  /* jscpd:ignore-end */
  const t = ctx.locale.bind(ACCESS_NS)
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
        return Promise.resolve(optionsOf(value, t))
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
