/** Registers the sidebar UI into the layout-owned slot. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'

export type { SidebarRootComponentProps, SidebarRootInjected } from './contract/slots.ts'

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'sessions']

/** Registers the sidebar component and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const injectProps = (): SidebarRootInjected => ({
    // Selection belongs to the sessions service; layout owns only panel geometry.
    onOpen: (id) => { ctx.sessions.open(id) },
    onCreate: (cwd) => {
      // Top-level New Session / New Workspace: clear selection so AppFrame
      // shows conversation.empty (EmptyState + shared InputBar). Per-project
      // "+" still create-then-opens into that cwd until workspace seeding
      // reaches the empty-state picker.
      if (cwd === undefined) {
        ctx.sessions.clear()
        return
      }
      void ctx.sessions.create({ cwd })
        .then((id: SessionId) => { ctx.sessions.open(id) })
    },
    onToggleSidebar: () => { ctx.layout.toggleSidebar() },
  })
  ctx.effect(
    () => ctx.slots.register({ name: 'sidebar', inject: injectProps }, SidebarRoot),
    'ui-sidebar: slot registration',
  )
}
