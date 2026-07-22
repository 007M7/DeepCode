/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot. The own injected share is declared here (a
 * share's type lives with whoever wires it); the owner share is referenced
 * off ui-layout's slot declaration through OwnerOf, never re-stated. Single
 * domain — this is the package's whole contract surface.
 */
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so OwnerOf<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarTreeState } from '../store.ts'

/** Cross-plugin actions bound in apply (layout / sessions services). */
export interface SidebarActions {
  open(id: SessionId): void
  create(cwd?: string): void
  toggleSidebar(): void
}

/** Plugin-owned tree viewing-state actions (tree store mutators). */
export interface SidebarTreeActions {
  toggleProject(key: string): void
  toggleSession(id: SessionId): void
  setQuery(query: string): void
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). A type alias, not an interface: the alias carries an implicit
 * index signature, so the factory's return crosses the registry's
 * `Record<string, unknown>` boundary uncast.
 */
export type SidebarRootInjected = {
  useTree: SnapshotSelectorHook<SidebarTreeState>
  /** Current session selector (row highlight); undefined selects nothing. */
  useCurrent: () => SessionId | undefined
  actions: SidebarActions
  tree: SidebarTreeActions
}

/**
 * Full component props: owner share referenced from ui-layout's declaration
 * plus the own injected share. Root scope has no standard injection
 * (useSession is session-scope only), so no standard term appears.
 */
export type SidebarRootComponentProps = OwnerOf<'sidebar'> & SidebarRootInjected
