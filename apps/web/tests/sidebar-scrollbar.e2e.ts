// Web e2e scenario: the sidebar session list's scrollbar as the browser
// actually lays it out — the observable half of the themed-scrollbar change
// (packages/client/ui-theme/src/styles/scrollbar.css plus the
// `scrollbar-gutter: stable` reservation on WorkspaceBrowser's `.list`). The
// ui-theme/ui-workspace unit specs read the CSS text; only a real engine
// reports the reserved gutter width and the substituted `scrollbar-color`, so
// those two facts live here.
//
// Zero model calls: the list only has to overflow, so the scenario seeds many
// cold sessions from another spec's committed fixture (seeded-history's
// seed.jsonl, reused read-only — this spec needs row count, not new recorded
// content) and never launches a replay row. A stray stream would fail loud
// with NO_ADAPTER.
//
// Headless-chromium caveat, load-bearing for what is asserted below: chromium
// paints an OVERLAY scrollbar that consumes no layout width. Comparing the
// time element's right edge against the list's client-area right edge
// therefore holds with and without the reservation and proves nothing; the
// reserved band width is the only layout signal that distinguishes the two
// states. See the assertions for which one is the control.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const MODE = webSnapshotMode()
/** Enough rows that the list overflows the 800px-tall viewport's sidebar; the scenario asserts the overflow rather than trusting it. */
const SEED_COUNT = 24

/** Geometry and resolved scrollbar style of one scroll container, measured in the page. */
interface ListMetrics {
  /** Resolved `scrollbar-gutter`. */
  gutter: string
  /** Resolved `scrollbar-width`. */
  width: string
  /** Resolved `scrollbar-color` (thumb then track). */
  color: string
  /** The thumb half of `scrollbar-color`, split off the track half. */
  thumb: string
  /** `--dsw-alias-scrollbar-bg-l1` resolved on the list into the same colour serialization `scrollbar-color` reports. */
  token: string
  /** True when the list actually scrolls. */
  overflows: boolean
  /** Border-box width minus client width: the space the scrollbar takes out of the content area. */
  band: number
  /** Client-area right edge in viewport coordinates (`clientWidth` excludes the scrollbar band). */
  clientRight: number
  /** Border-box right edge in viewport coordinates. */
  borderRight: number
  /** Right edge of the first row's relative-time element, the content the unreserved bar covered. */
  timeRight: number
}

/**
 * Measure the sidebar list in the page.
 * @param page - the page under test.
 * @returns the list's resolved scrollbar style and the geometry the fix changes.
 */
function measureList(page: Page): Promise<ListMetrics> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[role="tree"][aria-label="Sessions"]')
    if (list === null) throw new Error('sidebar session list not in the DOM')
    const time = list.querySelector<HTMLElement>('[class*="time"]')
    if (time === null) throw new Error('no row relative-time element in the sidebar list')
    // The token needs the same serialization `scrollbar-color` reports: the
    // palette sheet writes it in whatever notation it chose, so it is
    // resolved through a probe element's `color`. The probe is appended to
    // the list so `var()` substitution happens where the list sits in the
    // cascade — the token reaching THIS element is the claim.
    const probe = document.createElement('span')
    list.append(probe)
    probe.style.color = 'var(--dsw-alias-scrollbar-bg-l1)'
    const token = getComputedStyle(probe).color
    probe.remove()
    const style = getComputedStyle(list)
    // `scrollbar-color` serializes as `<thumb> <track>`; both halves are
    // functional colours, so the split is on the space before the track's
    // opening token, not on every space.
    const thumb = style.scrollbarColor.replace(/\s+rgba?\([^)]*\)$/, '')
    return {
      gutter: style.scrollbarGutter,
      width: style.scrollbarWidth,
      color: style.scrollbarColor,
      thumb,
      token,
      overflows: list.scrollHeight > list.clientHeight,
      band: list.getBoundingClientRect().width - list.clientWidth,
      clientRight: list.getBoundingClientRect().left + list.clientWidth,
      borderRight: list.getBoundingClientRect().right,
      timeRight: time.getBoundingClientRect().right,
    }
  })
}

/**
 * Reveal the seeded rows: every seeded session is unattached, so they all sit
 * in the collapsed Ungrouped bucket. Converges on expanded rather than
 * clicking once — startup auto-selection can expand the bucket first, and a
 * second click would collapse it again. Hand-rolled polling because
 * `expect.poll` is test-scoped and this runs in `beforeAll`.
 * @param page - the page under test.
 */
async function expandSeededSessions(page: Page): Promise<void> {
  const bucket = page.getByText('Ungrouped', { exact: true }).locator('..').locator('..')
  await bucket.waitFor({ timeout: 15_000 })
  const rows = page.locator('[role="tree"][aria-label="Sessions"] [role="treeitem"]')
  const deadline = Date.now() + 30_000
  for (;;) {
    if (await bucket.getAttribute('aria-expanded') !== 'true') {
      await page.getByText('Ungrouped', { exact: true }).click()
    }
    if (await bucket.getAttribute('aria-expanded') === 'true' && await rows.count() > SEED_COUNT / 2) return
    if (Date.now() > deadline) {
      throw new Error(`Ungrouped bucket never revealed more than ${SEED_COUNT / 2} rows`)
    }
    await page.waitForTimeout(200)
  }
}

describe('web e2e: sidebar session list scrollbar (reserved gutter / themed thumb)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    for (let index = 0; index < SEED_COUNT; index += 1) {
      await seedSession(scaffold, fixture, `sidebar-scrollbar-web-e2e-${String(index).padStart(2, '0')}`)
    }
    browser = await chromium.launch()
    // Shorter than the other scenarios' 1000px so SEED_COUNT rows overflow
    // the list with room to spare.
    page = await browser.newPage({ viewport: { width: 1680, height: 800 } })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expandSeededSessions(page)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reserves a scrollbar gutter on the overflowing session list', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-scrollbar-gutter'))
    // Vacuity guard: with a non-overflowing list `stable` still reserves, but
    // the scenario would no longer be reproducing the reported situation.
    await expect.poll(async () => (await measureList(page)).overflows, { timeout: 10_000 }).toBe(true)
    const metrics = await measureList(page)
    expect(metrics.gutter).toBe('stable')
    // The control. `band > 0` is the whole observable effect of the
    // reservation: the scrollbar is taken out of the content area instead of
    // drawn over it. Removing the declaration makes it exactly 0. The value
    // itself is not pinned — it tracks `scrollbar-width` and the platform.
    expect(metrics.band).toBeGreaterThan(0)
    // With the band reserved, the row's relative time — flush against the
    // row's right padding, the element the unreserved bar covered — ends
    // inside the content area, clear of the bar. Alone this would be vacuous
    // under chromium's overlay scrollbar (see the file header); it is
    // meaningful only conjoined with the band assertion above.
    expect(metrics.timeRight).toBeLessThanOrEqual(metrics.clientRight)
    expect(metrics.clientRight).toBeLessThan(metrics.borderRight)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('resolves the themed thumb colour on the list in both palettes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-scrollbar-theme'))
    const light = await measureList(page)
    // `thin`, not `auto`: the sheet's per-element declaration reached a
    // container it never names.
    expect(light.width).toBe('thin')
    // A concrete colour, not `auto`, and byte-equal to the alias token
    // resolved on this element: the indirection carried the token here rather
    // than falling back to the UA thumb.
    expect(light.color).not.toBe('auto')
    expect(light.thumb).toBe(light.token)
    // Transparent track, so the thumb reads against the scrolling surface.
    expect(light.color.endsWith('rgba(0, 0, 0, 0)')).toBe(true)
    // The dark palette declares different scrollbar tokens; driving the body
    // attribute pins the cascade the way lifecycle-chrome does (the Settings
    // gesture that sets it is owned there).
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const dark = await measureList(page)
    expect(dark.thumb).toBe(dark.token)
    expect(dark.thumb).not.toBe(light.thumb)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    expect((await measureList(page)).thumb).toBe(light.thumb)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
