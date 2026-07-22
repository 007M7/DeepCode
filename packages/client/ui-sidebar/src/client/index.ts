/**
 * Sidebar plugin, browser half: SidebarRoot registered into the layout-owned
 * sidebar slot; tree derivation materialized in a plugin-owned snapshot
 * store (pure consumer — no ctx service). Contract: api-contracts v3
 * section 6; props composition in contract/slots.ts.
 */
import type { RootBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { createSidebarTreeStore } from './store.ts'
import { SidebarRoot } from './SidebarRoot.tsx'

export {
  deriveRows, formatRelativeTime, projectLabel,
  UNGROUPED_KEY, UNGROUPED_LABEL,
  type ProjectRow, type SessionRow, type SidebarRow, type TreeView,
} from './tree.ts'
export {
  createSidebarTreeStore,
  type GroupBy, type SidebarTreeState, type SidebarTreeStore,
} from './store.ts'
export { ProjectRowItem, SessionRowItem } from './Rows.tsx'
export { SidebarRoot } from './SidebarRoot.tsx'
export type {
  SidebarActions, SidebarRootComponentProps, SidebarRootInjected, SidebarTreeActions,
} from './contract/slots.ts'

/** Required services (cordis fiber inject — the loader passes the whole export surface as an object plugin). */
export const inject = ['slots', 'layout', 'sessions']

/**
 * Client plugin body: build the tree store and register SidebarRoot into the
 * sidebar slot with the inject surface bound off the root binding's ctx.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.sessions

  ctx.effect(() => {
    const tree = createSidebarTreeStore(sessions)
    // Called once per registration (root slots cache per entry); services are
    // bound off the binding ctx per the contract's inject-surface wording.
    const injectProps = (b: RootBinding<ClientContext>): SidebarRootInjected => {
      const { sessions: boundSessions, layout } = b.ctx
      return {
        useTree: tree.store.useSelector,
        useCurrent: () => layout.current.useSelector(s => s.sessionId),
        actions: {
          open: (id) => { layout.open(id) },
          create: (cwd) => {
            // Create-then-open: the sidebar's three creation entries all land
            // in the new session (empty-state first-send stays with ui-conversation).
            void boundSessions.create(cwd === undefined ? {} : { cwd })
              .then((id: SessionId) => { layout.open(id) })
          },
          toggleSidebar: () => { layout.toggleSidebar() },
        },
        tree: {
          toggleProject: (key) => { tree.toggleProject(key) },
          toggleSession: (id) => { tree.toggleSession(id) },
          setQuery: (query) => { tree.setQuery(query) },
        },
      }
    }
    const disposeRegistration = ctx.slots.register('sidebar', SidebarRoot, { inject: injectProps })
    return () => {
      disposeRegistration()
      tree.dispose()
    }
  }, 'ui-sidebar: tree store + slot registration')
}
