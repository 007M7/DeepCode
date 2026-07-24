/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot. The own injected share is declared here (a
 * share's type lives with whoever wires it); the runtime share — owner
 * props {collapsed,width} plus the standard useSessions hook — is
 * PropsRuntime<'sidebar'>, resolved off ui-layout's SlotMap declaration and
 * never re-stated. Single domain — this is the package's whole contract
 * surface.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Registrant-private injected share (arrives via the register inject
 * factory): plain cross-service callbacks only — tree data rides the
 * standard useSessions hook and viewing state is component-local. A type
 * alias, not an interface: the alias carries an implicit index signature,
 * so the factory's return crosses the registry's `Record<string, unknown>`
 * boundary uncast.
 */
export type SidebarRootInjected = {
  /** Open (switch to) a session. */
  onOpen: (id: SessionId) => void
  /**
   * New-session affordance: no cwd clears selection onto the empty-state
   * launch; a cwd create-then-opens a session in that project group.
   */
  onCreate: (cwd?: string) => void
  /** Collapse the sidebar column (layout service action; owner share stays {collapsed,width}). */
  onToggleSidebar: () => void
}

/**
 * Full component props: the framework runtime share (owner {collapsed,width}
 * + standard useSessions) plus the own injected share. No children are
 * declared and no store is registered, so no PropsRenderSlots/PropsStore
 * term appears.
 */
export type SidebarRootComponentProps = PropsRuntime<'sidebar'> & SidebarRootInjected
