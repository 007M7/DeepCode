/** Registers the sidebar UI into the layout-owned slot. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'

export type { SidebarRootComponentProps, SidebarRootInjected, SidebarWorkspaceOwnerProps } from './contract/slots.ts'

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
      // SidebarRoot owns this picker site; ui-workspace registers the shared
      // picker that selects a Host Workspace for a frontend Session Intent.
      children: { 'sidebar.workspace': { kind: 'single', scope: 'root' } },
      inject: injectProps,
    }, SidebarRoot),
    'ui-sidebar: slot registration',
  )
}
