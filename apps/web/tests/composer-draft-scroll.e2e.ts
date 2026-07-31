// Web e2e scenario: a composer draft longer than the 14-line cap scrolls its
// GLYPHS, not just its caret.
//
// The composer paints its text in two stacked layers (see
// packages/client/ui-conversation/src/client/skeleton/InputBar.module.css): the
// `<textarea>` carries the value, the selection and the caret but renders its
// own glyphs `color: transparent`, and every visible character is painted by the
// `[data-input-backdrop]` div underneath it, which also carries the claim-token
// highlight, the chips and the ghost hint. The backdrop is `position: absolute;
// inset: 0; overflow: hidden` — it is CLIPPED, not scrolled, and nothing in the
// browser links its scroll offset to the textarea's.
//
// So past the cap the textarea scrolled and the words did not: the caret walked
// off the bottom of a block of text frozen at line 1, and no gesture — wheel,
// drag, arrow key — moved it. `InputBar` now mirrors the offset onto the
// backdrop on every textarea `scroll` and after every committed draft.
//
// Only a real engine can show this. Scrolling is layout: jsdom reports
// `scrollHeight === clientHeight` for every element and never scrolls one, so
// the unit spec in packages/client/ui-conversation/tests/input-bar.spec.tsx has
// to stub both offsets and can only prove the mirroring code path runs. What is
// asserted here instead is the user-visible fact that path exists for — after
// scrolling to the end of a long draft, the LAST line is the one on screen —
// measured with a DOM Range over the backdrop's own text.
//
// Zero model calls: a fresh workspace's blank session already carries a live
// composer, and the scenario only types into it. A stray stream would fail loud
// with NO_ADAPTER.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/composer-draft-scroll', import.meta.url))
/**
 * Committed golden of the composer's two-layer scroll geometry. The change
 * alters no DOM and no accessible name, so the aria goldens the other scenarios
 * commit are byte-identical with and without it; this records the relations
 * instead, which makes a shift in the cap or in the layer coupling a reviewable
 * diff rather than an assertion someone has to reconstruct.
 */
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()

/** Marks the first and last line so a Range can find them in the backdrop's text. */
const FIRST_MARKER = 'FIRST-LINE-MARKER'
const LAST_MARKER = 'LAST-LINE-MARKER'
/** Comfortably past the 14-line cap, so the draft overflows however the lines wrap. */
const DRAFT_LINES = 40
const DRAFT = Array.from({ length: DRAFT_LINES }, (_unused, index) => {
  if (index === 0) return FIRST_MARKER
  if (index === DRAFT_LINES - 1) return LAST_MARKER
  return `draft line ${String(index + 1).padStart(2, '0')}`
}).join('\n')

/** The composer's two text layers as the browser lays them out. */
interface ComposerMetrics {
  /** True when the draft is taller than the capped box — the situation under test. */
  overflows: boolean
  /** Visible height of the textarea's content box: the cap in pixels. */
  clientHeight: number
  /** Whole lines that fit in the visible box, at the composer's own line-height. */
  visibleLines: number
  /** The textarea's scroll offset, which the caret and the selection follow. */
  inputScrollTop: number
  /** The backdrop's scroll offset, which every visible glyph follows. */
  backdropScrollTop: number
  /** True when the two layers agree — the coupling this scenario exists for. */
  layersAgree: boolean
  /**
   * Top of the LAST draft line relative to the visible box's top, in pixels: at
   * most `clientHeight` when that line is on screen. This is the reported
   * symptom as a number — with the layers uncoupled the backdrop stays at offset
   * 0, so the last line sits a full draft-height below the box.
   */
  lastLineOffset: number
  /** Top of the FIRST draft line relative to the visible box's top: negative once it has scrolled out. */
  firstLineOffset: number
}

/**
 * Measure both composer layers in the page.
 * @param page - the page under test.
 * @returns the two layers' offsets and where the draft's first and last lines sit.
 */
function measureComposer(page: Page): Promise<ComposerMetrics> {
  return page.evaluate(({ first, last }) => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea:enabled')
    if (input === null) throw new Error('no live composer textarea in the DOM')
    const backdrop = input.parentElement?.querySelector<HTMLElement>('[data-input-backdrop]')
    if (backdrop === undefined || backdrop === null) throw new Error('no decoration backdrop beside the composer textarea')
    const box = input.getBoundingClientRect()
    // The draft carries no chips or claim token, so the backdrop holds exactly
    // one text node — the plain-text arm of the decoration walk.
    const text = backdrop.firstChild
    if (!(text instanceof Text)) throw new Error('backdrop is not a single plain text node')
    const offsetOf = (marker: string): number => {
      const at = text.data.indexOf(marker)
      if (at < 0) throw new Error(`marker ${marker} missing from the backdrop text`)
      const range = document.createRange()
      range.setStart(text, at)
      range.setEnd(text, at + marker.length)
      return range.getBoundingClientRect().top - box.top
    }
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight)
    return {
      overflows: input.scrollHeight > input.clientHeight,
      clientHeight: input.clientHeight,
      visibleLines: Math.floor(input.clientHeight / lineHeight),
      inputScrollTop: input.scrollTop,
      backdropScrollTop: backdrop.scrollTop,
      layersAgree: input.scrollTop === backdrop.scrollTop,
      lastLineOffset: offsetOf(last),
      firstLineOffset: offsetOf(first),
    }
  }, { first: FIRST_MARKER, last: LAST_MARKER })
}

/**
 * Render the golden body.
 *
 * Absolute glyph coordinates are deliberately absent: they depend on font
 * metrics and would make the fixture fail on a machine that measures text
 * differently — a golden that needs re-recording per platform documents the
 * platform, not the change. What is recorded is the cap, the layer agreement,
 * and which lines are on screen, each a comparison that survives any layout
 * keeping the coupling.
 * @param top - metrics with the draft scrolled to its start.
 * @param bottom - metrics with the draft scrolled to its end.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(top: ComposerMetrics, bottom: ComposerMetrics): string {
  return [
    '# Composer draft scrolling (14-line cap, two text layers)',
    '',
    '## At the start of the draft',
    '',
    `- draft overflows the capped box: ${String(top.overflows)}`,
    `- visible lines: ${String(top.visibleLines)}`,
    `- textarea scroll offset: ${String(top.inputScrollTop)}px`,
    `- glyph layer tracks it: ${String(top.layersAgree)}`,
    `- first draft line is on screen: ${String(top.firstLineOffset >= 0 && top.firstLineOffset < top.clientHeight)}`,
    `- last draft line is on screen: ${String(top.lastLineOffset >= 0 && top.lastLineOffset < top.clientHeight)}`,
    '',
    '## Scrolled to the end of the draft',
    '',
    `- textarea moved: ${String(bottom.inputScrollTop > 0)}`,
    `- glyph layer tracks it: ${String(bottom.layersAgree)}`,
    `- first draft line has scrolled out above: ${String(bottom.firstLineOffset < 0)}`,
    `- last draft line is on screen: ${String(bottom.lastLineOffset >= 0 && bottom.lastLineOffset < bottom.clientHeight)}`,
  ].join('\n').trimEnd()
}

describe('web e2e: composer draft scrolling', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, 'composer-draft-scroll')
    await page.locator('textarea:enabled').first().fill(DRAFT)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('caps the draft box and keeps both text layers at the start', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-top'))
    // Vacuity guard: without an overflowing draft there is nothing to scroll and
    // every assertion below holds trivially.
    await expect.poll(async () => (await measureComposer(page)).overflows, { timeout: 10_000 }).toBe(true)
    // Typing the draft left the caret — and the box — at its end, so reach the
    // start by the same gesture a user would, and leave it there for the wheel
    // case below.
    await page.locator('textarea:enabled').first().hover()
    await page.mouse.wheel(0, -2000)
    await expect.poll(async () => (await measureComposer(page)).inputScrollTop, { timeout: 10_000 }).toBe(0)
    const metrics = await measureComposer(page)
    // The cap is the composer seat's `--dsh-composer-text-max-height` (336px =
    // 14 x 24px lines). The count, not the pixels: it is the figma constant and
    // survives a device-pixel-ratio change.
    expect(metrics.visibleLines).toBe(14)
    // Resting state: the draft's head is what a 40-line draft shows, and its
    // tail is far below the box. Both layers sit at the origin, which is why the
    // uncoupled build looks correct until something scrolls.
    expect(metrics.inputScrollTop).toBe(0)
    expect(metrics.layersAgree).toBe(true)
    expect(metrics.firstLineOffset).toBeGreaterThanOrEqual(0)
    expect(metrics.firstLineOffset).toBeLessThan(metrics.clientHeight)
    expect(metrics.lastLineOffset).toBeGreaterThan(metrics.clientHeight)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('a wheel gesture over a long draft moves the words, not only the caret', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-wheel'))
    const input = page.locator('textarea:enabled').first()
    await input.hover()
    // One delta past the whole draft: the textarea clamps at its own end, and
    // the wheel-chaining handler leaves it native because the box is not yet at
    // its edge when the gesture starts (the chaining itself is owned by the
    // unit spec).
    await page.mouse.wheel(0, 2000)
    await expect.poll(async () => (await measureComposer(page)).inputScrollTop, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const metrics = await measureComposer(page)
    // The coupling, stated directly.
    expect(metrics.layersAgree).toBe(true)
    // The reported symptom, stated as what the user sees: the end of the draft
    // is on screen and its beginning is not. On the uncoupled build the glyph
    // layer stays at offset 0, so `lastLineOffset` is still a full draft below
    // the box and `firstLineOffset` is still 0 — the text never moved.
    expect(metrics.lastLineOffset).toBeGreaterThanOrEqual(0)
    expect(metrics.lastLineOffset).toBeLessThan(metrics.clientHeight)
    expect(metrics.firstLineOffset).toBeLessThan(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('typing at the end of a scrolled draft keeps the layers together', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-edit'))
    // The other way the box moves. Typing at the caret — parked at the draft's
    // end by the wheel gesture — scrolls it into view, which is a `scroll` like
    // any other; this pins that an edit is not a separate case needing its own
    // mirror, which is why one listener is the whole implementation.
    const input = page.locator('textarea:enabled').first()
    await input.press('End')
    await input.pressSequentially(' tail')
    const metrics = await measureComposer(page)
    expect(metrics.layersAgree).toBe(true)
    expect(metrics.lastLineOffset).toBeGreaterThanOrEqual(0)
    expect(metrics.lastLineOffset).toBeLessThan(metrics.clientHeight)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('matches the committed composer scroll geometry golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-draft-scroll-golden'))
    const input = page.locator('textarea:enabled').first()
    // Restore the pristine draft (the edit case appended to it) and return to
    // its start, both through ordinary gestures.
    await input.fill(DRAFT)
    await input.hover()
    await page.mouse.wheel(0, -2000)
    await expect.poll(async () => (await measureComposer(page)).inputScrollTop, { timeout: 10_000 }).toBe(0)
    const top = await measureComposer(page)
    await input.hover()
    await page.mouse.wheel(0, 2000)
    await expect.poll(async () => (await measureComposer(page)).inputScrollTop, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const bottom = await measureComposer(page)
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(top, bottom), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('commits exactly the fixtures it reads', async () => {
    // Zero model calls, so the scenario records no session fixture: the geometry
    // golden is the whole inventory.
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
