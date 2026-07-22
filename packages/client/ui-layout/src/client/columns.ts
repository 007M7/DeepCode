/**
 * Pure concession-chain column solver for the three-column AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details first, then sidebar, then auto-closing details (derived zero width —
 * persisted open/width preferences are never rewritten, so widening the window
 * restores them). Center absorbs any remaining deficit as the last resort.
 */

/** Panel viewing state consumed by the solver (mirrors LayoutService PanelState). */
export interface PanelInput { open: boolean; width: number }

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 240
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 300
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. After the auto-close step the details pressure is
 * gone, so the sidebar returns to its preferred width when it fits.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar preference (open flag + persisted width).
 * @param details - details preference (open flag + persisted width).
 * @returns resolved widths; details 0 means visually closed (never unmounted).
 */
export function computeColumns(viewport: number, sidebar: PanelInput, details: PanelInput): Columns {
  const want = (p: PanelInput, min: number, max: number): number =>
    p.open ? clampWidth(p.width, min, max) : 0
  const s0 = want(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = want(details, DETAILS_MIN, DETAILS_MAX)

  // Step 1: everything fits at preferred widths.
  if (s0 + d0 + CENTER_MIN <= viewport) return { sidebar: s0, center: viewport - s0 - d0, details: d0 }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s0 - CENTER_MIN)
  if (s0 + d1 + CENTER_MIN <= viewport) return { sidebar: s0, center: CENTER_MIN, details: d1 }

  // Step 3: shrink sidebar toward its minimum.
  const s1 = s0 === 0 ? 0 : Math.max(SIDEBAR_MIN, viewport - d1 - CENTER_MIN)
  if (s1 + d1 + CENTER_MIN <= viewport) return { sidebar: s1, center: CENTER_MIN, details: d1 }

  // Step 4: auto-close details (derived — preferences untouched). With the
  // details pressure gone the sidebar concession is re-solved from preference.
  if (d1 > 0) {
    if (s0 + CENTER_MIN <= viewport) return { sidebar: s0, center: viewport - s0, details: 0 }
    const s2 = s0 === 0 ? 0 : Math.max(SIDEBAR_MIN, viewport - CENTER_MIN)
    return { sidebar: s2, center: Math.max(0, viewport - s2), details: 0 }
  }

  // Step 5: center absorbs the deficit (may drop below CENTER_MIN).
  return { sidebar: s1, center: Math.max(0, viewport - s1 - d1), details: d1 }
}
