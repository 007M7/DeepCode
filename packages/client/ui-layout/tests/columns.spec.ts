import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns,
  DETAILS_DEFAULT, DETAILS_MIN, SIDEBAR_DEFAULT, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/client'

const open = (width: number) => ({ open: true, width })
const closed = (width: number) => ({ open: false, width })

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 300, center: 1920 - 300 - 360, details: 360 })
  })

  it('closed panels contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360))).toEqual({ sidebar: 0, center: 1920, details: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(1))
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 300 + 360 + 640 = 1300 > 1250; details concedes to 1250-300-640 = 310.
    const cols = computeColumns(1250, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 310 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), open(360))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), open(360))
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359 })
  })

  it('step 3: sidebar concedes after details hits its min', () => {
    // details floor 300: sidebar = 1220-300-640 = 280.
    const cols = computeColumns(1220, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: DETAILS_MIN })
  })

  it('step 4: details auto-closes when both panels are at min and center still starves', () => {
    // 240 + 300 + 640 = 1180 > 1100 → details 0; sidebar preference (300) fits: 1100-300 = 800 center.
    const cols = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 300, center: 800, details: 0 })
  })

  it('step 4 keeps squeezing sidebar when preference no longer fits', () => {
    // 900 < 300+640: sidebar = max(240, 900-640) = 260.
    const cols = computeColumns(900, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 260, center: CENTER_MIN, details: 0 })
  })

  it('step 5: center absorbs the deficit as last resort (details closed)', () => {
    // 700 < 240+640: sidebar floors at 240, center takes 460 < CENTER_MIN.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_MIN, center: 460, details: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(DETAILS_MIN + CENTER_MIN, closed(300), open(DETAILS_DEFAULT))
    expect(fits).toEqual({ sidebar: 0, center: CENTER_MIN, details: DETAILS_MIN })
    const starved = computeColumns(DETAILS_MIN + CENTER_MIN - 1, closed(300), open(DETAILS_DEFAULT))
    expect(starved).toEqual({ sidebar: 0, center: DETAILS_MIN + CENTER_MIN - 1, details: 0 })
  })

  it('tiny viewport: both panels yield everything to center', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_MIN)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_MIN))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes all', () => {
    // Reaches step 4's re-solve with s0 = 0 (the closed-sidebar arm).
    expect(computeColumns(500, closed(300), open(DETAILS_DEFAULT)))
      .toEqual({ sidebar: 0, center: 500, details: 0 })
  })
})
