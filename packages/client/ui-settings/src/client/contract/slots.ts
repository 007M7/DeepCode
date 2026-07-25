/**
 * Settings shell slot contract: the shell occupies the sidebar-owned
 * `sidebar.settings` hole and declares the `settings.section` list slot that
 * section plugins (General, Models, …) contribute pages into.
 */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.settings' entry)
// into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One settings page per list entry. Registrant options carry the nav
     * identity: `id` (section key, drives `only` filtering), `order` (nav
     * position), `label` (registrant-localized display text — the registrant
     * re-registers with fresh text on locale change, so the shell never
     * subscribes locale/theme state; the ledger bump doubles as the shell's
     * re-render trigger). Sections render inside the panel content column.
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
  }
}

/**
 * Owner share of a settings section entry. The shell owns modal visibility
 * and navigation; sections receive nothing but the render site (their data
 * arrives through their own inject faces and stores).
 */
export interface SettingsSectionOwnerProps {
  /** Marker field: section owner props are intentionally empty for now. */
  children?: never
}

/**
 * Registrant-private injected share of the settings shell (assembled in
 * apply): locale-resolved nav labels come through `translate`.
 */
export type SettingsRootInjected = {
  /**
   * Resolve a "<ns>:<key>" locale reference to the active-locale text —
   * shell chrome copy only (trigger/title/close); nav labels arrive already
   * localized. Read at render time; the locale-change re-render rides the
   * section ledger bump, not a shell-owned subscription.
   */
  translate: (ref: string) => string
  /** Read the settings.section ledger version (nav invalidation). */
  sectionsVersion: () => number
  /** Subscribe to settings.section ledger changes. */
  subscribeSections: (listener: () => void) => () => void
  /** Project the settings.section ledger into nav rows (id/order/label). */
  sections: () => readonly { id: string; order: number; label: string }[]
}

/**
 * Full component props of the settings shell root: the sidebar owner share
 * (wide/rail state) plus the declared section render share and the injected
 * face. No store is registered — modal open state and active section id are
 * component-local viewing state.
 */
export type SettingsRootComponentProps =
  PropsRuntime<'sidebar.settings'> & PropsRenderSlots<'settings.section'> & SettingsRootInjected
