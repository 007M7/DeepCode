/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot, plus the workspace-browser hole this shell
 * declares. The shell owns column geometry (fold state machine, brand row,
 * New Session, Settings); everything between the section header and the list
 * bottom is the `sidebar.workspaces` registrant's (ui-workspace).
 */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The workspace/session browsing region: section header, search, the
     * grouped/flat session list, and every workspace dialog. Declared by this
     * package's 'sidebar' entry (declaring is claiming); ui-workspace
     * registers the browser.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
  }
}

/**
 * Owner share of the browser hole — the only facts crossing the shell/region
 * seam. Business data and actions arrive through the region's own inject.
 */
export interface SidebarSectionOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  wide: boolean
  /** Rail icons request expansion; the browser rides the wide flip for focus. */
  expandSidebar: () => void
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). The shell keeps only its own controls: starting a Session from
 * the New Session button and toggling the column.
 */
export type SidebarRootInjected = {
  /** Start or replace the current frontend Session Intent. */
  startSession: (workspaceId?: WorkspaceId, prompt?: string) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
}

/**
 * Full component props: layout owner state/actions plus the browser hole's
 * render share and this package's injected callbacks. No store is registered.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'> & PropsRenderSlots<'sidebar.workspaces'> & SidebarRootInjected
