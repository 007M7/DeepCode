/**
 * The root entry's layout store: panel geometry as plain widths in px
 * (0 = closed), persisted across reloads. Module level exports the factory
 * only — a module-level handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore } from '@deepseek-ai/dsh-client-web-react'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Create the layout panel store handle. The persisted preference IS the
 * width, so closing a panel forgets its drag width — reopening restores the
 * contract default. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions write 0 / the default explicitly.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore() {
  return defineStore({
    init: () => ({ sidebar: SIDEBAR_DEFAULT, details: 0 }),
    persist: 'dsh.layout.panels',
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      toggleSidebar: (d) => { d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0 },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
    },
  })
}
