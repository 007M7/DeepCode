// Web e2e scenario: the conversation column scrolls on one axis only, as the
// browser actually lays it out. The reported symptom was a horizontal
// scrollbar under the whole center column once the window (or the sidebar
// drag) narrowed it — the hero's decorative backdrop ellipse bleeding past the
// column and becoming user-scrollable.
//
// The bleed is by construction and stays: `.heroGlow` is sized 1051/776 of the
// hero box (ConversationRoot.module.css) so the blur scales with the input
// card. What changed is the scroll container: `[data-conversation-scroll]`
// scrolls vertically, and a box that scrolls in one axis computes the other
// axis's initial `visible` to `auto`, so the bleed came back as a bar. The
// fix states `overflow-x: hidden` there.
//
// Only a real engine reports that pair — the bleed and the resulting scroll
// range — so the scenario sweeps viewport widths that bracket the glow's
// width and asserts both at each stop. Asserting no horizontal scroll alone
// would go vacuous the moment the glow stopped bleeding for an unrelated
// reason, which is why each stop also records whether it bleeds; the wide stop
// is the control where it does not.
//
// Zero model calls: the hero is the boot state, so nothing is seeded and no
// replay row mounts. A stray stream would fail loud with NO_ADAPTER.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/conversation-column-overflow', import.meta.url))
/**
 * Committed golden of the one-axis relation at every stop. It records
 * relations and booleans, never absolute coordinates: the column width follows
 * the viewport and the sidebar, and a golden carrying pixels would document the
 * platform instead of the change.
 */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()
/**
 * Viewport widths bracketing the glow. The hero box is `min(776, column - 48)`
 * and the glow is 1051/776 of it, so every stop under a ~1051px column bleeds
 * and the widest one does not — the sweep therefore covers both sides of the
 * relation rather than sampling one comfortable width.
 */
const WIDTHS = [1680, 1200, 1000, 800, 600]
/** Element id of the mutation control's injected sheet, so the test can take it back out. */
const CONTROL_STYLE_ID = 'dsh-column-overflow-control'

/** One viewport stop: whether the glow bleeds past the column, and whether that bleed scrolls. */
interface ColumnMetrics {
  /** Viewport width the stop was measured at. */
  width: number
  /** The column's content width. Not committed to the golden — it is what settles after a resize, and what the sweep waits on. */
  columnWidth: number
  /** Resolved `overflow-x` on the conversation scroll container. */
  overflowX: string
  /** True when the glow's box reaches past the column's content edge — the condition the fix has to survive. */
  glowBleeds: boolean
  /**
   * `scrollWidth - clientWidth`. Deliberately NOT the assertion: `hidden` and
   * `auto` both report the same value, because `hidden` clips the bleed rather
   * than reflowing it away. Recorded because it is the vacuity guard in
   * numbers — it must stay positive at the narrow stops, or the scenario has
   * stopped reproducing the situation the fix is for.
   */
  bleedRange: number
  /** True when the column still scrolls vertically — the axis the fix must not take away. */
  scrollsVertically: boolean
}

/**
 * Measure the conversation column at the page's current viewport.
 * @param page - the page under test.
 * @param width - the viewport width already applied, recorded with the reading.
 * @returns the stop's overflow relations.
 */
function measureColumn(page: Page, width: number): Promise<ColumnMetrics> {
  return page.evaluate((viewportWidth) => {
    const scroller = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (scroller === null) throw new Error('conversation scroll container not in the DOM')
    const glow = scroller.querySelector<SVGElement>('[class*="heroGlow"]')
    if (glow === null) throw new Error('hero glow not in the DOM — the boot state is not the hero')
    const box = scroller.getBoundingClientRect()
    const glowBox = glow.getBoundingClientRect()
    return {
      width: viewportWidth,
      columnWidth: scroller.clientWidth,
      overflowX: getComputedStyle(scroller).overflowX,
      // `clientWidth` is the content edge, which is what the scrollable
      // overflow region is measured against; either side counts as a bleed,
      // though only the right one can produce a bar in this writing mode.
      glowBleeds: glowBox.right > box.left + scroller.clientWidth + 0.5 || glowBox.left < box.left - 0.5,
      bleedRange: scroller.scrollWidth - scroller.clientWidth,
      scrollsVertically: getComputedStyle(scroller).overflowY === 'auto',
    }
  }, width)
}

/**
 * Scroll the column sideways the way a user would and report where it landed.
 *
 * This is the one signal that separates the two states, and it is why the
 * scenario needs a real engine: `overflow-x: hidden` leaves the box
 * programmatically scrollable and leaves `scrollWidth` untouched, so every
 * property reading agrees across the fix. Only refusing an actual input event
 * differs — measured at the 1200px stop, the shipped column stays at 0 while
 * the same page with `overflow-x: auto` forced on lands at the full 66px bleed.
 * @param page - the page under test.
 * @returns `scrollLeft` after one horizontal wheel over the column.
 */
async function wheelHorizontally(page: Page): Promise<number> {
  const origin = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (scroller === null) throw new Error('conversation scroll container not in the DOM')
    // Start from the origin so the reading is this gesture's own effect.
    scroller.scrollLeft = 0
    const box = scroller.getBoundingClientRect()
    // Near the top of the column, clear of the centered hero card: the wheel
    // must reach the column, not a nested scroller the composer owns.
    return { x: box.left + box.width / 2, y: box.top + 60 }
  })
  await page.mouse.move(origin.x, origin.y)
  await page.mouse.wheel(300, 0)
  // Two frames: the scroll applies during the frame the wheel is dispatched
  // into, and is readable in the next. Polling for a settled value cannot be
  // used here — the value under test is 0, which a poll starting at 0 accepts
  // before the gesture has had any chance to move it. The timing is the same
  // on both sides of the mutation control below, which is what makes a 0
  // reading evidence rather than a race won.
  return page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve(document.querySelector<HTMLElement>('[data-conversation-scroll]')?.scrollLeft ?? -1)
      })
    })
  }))
}

/** A stop's readings plus where a horizontal wheel over it landed. */
type ColumnStop = ColumnMetrics & {
  /** `scrollLeft` after one horizontal wheel: the user-facing claim, 0 at every stop. */
  scrollLeftAfterWheel: number
}

/**
 * Render the golden body: one line per stop, relations only.
 *
 * Absolute pixels are deliberately absent apart from `scrollLeftAfterWheel`,
 * which the fix pins to 0 by construction. The bleed is recorded as a boolean
 * rather than its width, so the golden survives any platform whose column
 * lands a pixel off — a fixture that has to be re-recorded per platform
 * documents the platform, not the change.
 * @param stops - the measured stops, in sweep order.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(stops: ColumnStop[]): string {
  return [
    '# Conversation column horizontal overflow',
    '',
    '| viewport | overflow-x | glow bleeds past the column | scrollLeft after a horizontal wheel | scrolls vertically |',
    '| --- | --- | --- | --- | --- |',
    ...stops.map(stop => `| ${String(stop.width)}px | ${stop.overflowX} | ${String(stop.glowBleeds)} `
      + `| ${String(stop.scrollLeftAfterWheel)}px | ${String(stop.scrollsVertically)} |`),
  ].join('\n')
}

describe('web e2e: the conversation column scrolls on one axis', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[data-conversation-scroll] [class*="heroGlow"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Sweep the stops once and hand the readings to every assertion below, so
   * the golden and the assertions describe the same measurement rather than
   * two runs that could disagree.
   * @returns the stops in {@link WIDTHS} order.
   */
  const sweep = async (): Promise<ColumnStop[]> => {
    const stops: ColumnStop[] = []
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      // The glow rides the hero box, which rides the column, and the column's
      // track animates: settle on a column width that stops moving, or a stop
      // gets read mid-transition and reports the previous viewport's relation.
      let previous = -1
      await expect.poll(async () => {
        const current = (await measureColumn(page, width)).columnWidth
        const settled = current === previous
        previous = current
        return settled
      }, { timeout: 10_000 }).toBe(true)
      stops.push({ ...await measureColumn(page, width), scrollLeftAfterWheel: await wheelHorizontally(page) })
    }
    return stops
  }

  it('never scrolls horizontally, at any width the glow bleeds past', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-column-overflow'))
    const stops = await sweep()
    // The vacuity guard, in two halves: the glow has to reach past the column
    // at the narrow stops, and that reach has to still register as scrollable
    // overflow. Without both, the claim below holds for free.
    expect(stops.filter(stop => stop.glowBleeds).map(stop => stop.width)).toEqual([1200, 1000, 800, 600])
    for (const stop of stops.filter(stop => stop.glowBleeds)) {
      expect(stop.bleedRange, `viewport ${String(stop.width)}`).toBeGreaterThan(0)
    }
    for (const stop of stops) {
      expect(stop.overflowX, `viewport ${String(stop.width)}`).toBe('hidden')
      // The reported symptom, stated directly: a horizontal wheel over the
      // column moves nothing, at every stop.
      expect(stop.scrollLeftAfterWheel, `viewport ${String(stop.width)}`).toBe(0)
      // The axis the column is a scroller for must survive the fix.
      expect(stop.scrollsVertically, `viewport ${String(stop.width)}`).toBe(true)
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('reports the pre-fix state when the axis is opened back up', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-column-overflow-control'))
    // The mutation control, run in the page rather than against a second
    // build: it restores exactly what the fix changed — the initial `visible`
    // that a one-axis scroller computes to `auto` — and shows the same gesture,
    // at the same timing, carrying the column to the full bleed. Without it a
    // `scrollLeft` of 0 could equally mean the wheel never arrived.
    await page.setViewportSize({ width: 1200, height: 900 })
    // Injected with an id rather than through `addStyleTag`, so the teardown
    // below can take the sheet out again by selector: it must not outlive this
    // test, or the golden ends up reading the control.
    await page.evaluate((id: string) => {
      const sheet = document.createElement('style')
      sheet.id = id
      sheet.textContent = '[data-conversation-scroll] { overflow-x: auto !important; }'
      document.head.append(sheet)
    }, CONTROL_STYLE_ID)
    try {
      const before = await measureColumn(page, 1200)
      expect(before.overflowX).toBe('auto')
      expect(await wheelHorizontally(page)).toBe(before.bleedRange)
      expect(before.bleedRange).toBeGreaterThan(0)
    } finally {
      await page.evaluate((id: string) => {
        document.getElementById(id)?.remove()
      }, CONTROL_STYLE_ID)
    }
    // The override is gone and the shipped state is back: the later goldens
    // read the product, not the control.
    expect((await measureColumn(page, 1200)).overflowX).toBe('hidden')
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('matches the committed column-overflow golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-column-overflow-golden'))
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(await sweep()), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('commits exactly the fixtures it reads', async () => {
    // No model calls, so no replay log: the golden is the whole inventory.
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
