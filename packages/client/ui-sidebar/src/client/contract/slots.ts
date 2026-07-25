/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot and the Workspace picker hole declared here.
 * The runtime share combines layout-owned page state and actions with the
 * global useSessions and useWorkspaces hooks; the injected share adds the
 * runtime navigation actions and sidebar toggle.
 */
import type { RefObject } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The workspace picker hole in the sidebar section header (anchored at
     * the ＋ button). Declared by this package's 'sidebar' entry (declaring
     * is claiming); ui-workspace registers the picker.
     */
    'sidebar.workspace': { kind: 'single'; scope: 'root'; owner: SidebarWorkspaceOwnerProps }
  }
}

/**
 * Owner share of the sidebar workspace hole: popover geometry plus the
 * sidebar's pick semantics. The picked Host Workspace is already real; the
 * callback starts a frontend Session Intent targeted to it.
 */
export interface SidebarWorkspaceOwnerProps {
  /** Popover visibility (＋ button toggle state, host-local). */
  open: boolean
  /**
   * The ＋ button element — the popover's placement anchor. The picker's
   * slot span renders elsewhere in the DOM, so without this the menu
   * positions off the zero-size placement span (order-dependent). Optional
   * only until the host passes it; absent falls back to in-place placement.
   */
  anchorRef?: RefObject<HTMLElement>
  /** Start a frontend Session in a selected or newly created real Workspace. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). Host Workspace and Session data use the global framework hooks;
 * navigation and panel actions are plain callbacks, and viewing state remains
 * component-local. A type alias supplies the implicit index signature required
 * by the registry.
 */
export type SidebarRootInjected = {
  /** Start or replace the current frontend Session Intent. */
  startSession: (workspaceId?: WorkspaceId, prompt?: string) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
}

/**
 * Full component props: layout owner state/actions plus global useSessions
 * and useWorkspaces, the declared Workspace picker render share, and this
 * package's injected callback. No store is registered.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'> & PropsRenderSlots<'sidebar.workspace'> & SidebarRootInjected
