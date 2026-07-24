/**
 * Sidebar plugin, browser half: SidebarRoot registered into the layout-owned
 * sidebar slot. Pure consumer — the session list arrives through the
 * standard useSessions prop, tree rows derive in the component, and the
 * inject surface is plain cross-service callbacks closed over the plugin's
 * own ctx (slot design sections 5 and 6); props composition in
 * contract/slots.ts. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'

export type { SidebarRootComponentProps, SidebarRootInjected } from './contract/slots.ts'

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots', 'layout', 'sessions']

/**
 * Client plugin body: register SidebarRoot into the sidebar slot. The inject
 * factory returns service callbacks only (no hooks, no store lines) — all
 * data reads ride the framework's standard useSessions delivery.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injectProps = (): SidebarRootInjected => ({
    // Selection lives with the runtime sessions service (current rides the
    // list snapshot); layout keeps only panel geometry.
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
