/** Registers the sidebar UI into the layout-owned slot. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'

export type { SidebarRootComponentProps, SidebarRootInjected, SidebarSettingsOwnerProps, SidebarWorkspaceOwnerProps } from './contract/slots.ts'

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces']

/** Registers the sidebar component and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const injectProps = (): SidebarRootInjected => ({
    startSession: (workspaceId, prompt) => { ctx.workspaces.startSession(workspaceId, prompt) },
    open: (sessionId) => { ctx.sessions.open(sessionId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
  })
  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      // SidebarRoot owns these sites; ui-workspace registers the shared
      // picker, ui-settings registers the settings trigger + panel.
      children: {
        'sidebar.workspace': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'ui-sidebar: slot registration',
  )
}
