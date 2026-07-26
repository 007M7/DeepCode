/** Registers the sidebar shell into the layout-owned slot. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'

export type { SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSettingsOwnerProps } from './contract/slots.ts'

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces']

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button targets the most recently active
    // Workspace; an explicit Workspace still wins for scoped create actions.
    startSession: (workspaceId) => {
      const target = workspaceId ?? ctx.workspaces.list.getSnapshot().recentWorkspaceId
      if (target === undefined) {
        ctx.sessions.clear()
        return
      }
      void ctx.workspaces.connectWorkspace(target).then(
        (sessionId) => { ctx.sessions.open(sessionId) },
        (reason: unknown) => { console.warn('new session failed:', reason) },
      )
    },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
  })
  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      // The shell owns geometry; ui-workspace registers the whole browsing
      // region (header, search, session list, workspace dialogs), ui-settings
      // registers the foot trigger + settings panel.
      children: {
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'ui-sidebar: slot registration',
  )
}
