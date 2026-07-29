// Web e2e scenarios: lifecycle & chrome — the workspace-aware first-send
// flow over the real wire, reload recovery, and the dark-mode token cascade.
// One tiny recorded turn (text-only) drives the whole spec: the empty-state
// hero materializes a real Workspace + Session on first send (the jsdom
// workspace-flow suite pins the object-layer state machine over the fixture
// client; THIS spec pins the same flow through HTTP RPC + SSE + the host
// gateway), reload replays everything from the log (zero further model
// calls), and the theme scenario proves the shipped dark palette actually
// cascades: attribute -> alias token flip -> painted surface change. Per the
// lane's scope ruling there is no theme/layout golden (aria is color-blind);
// the hero's waiting state gets the one golden here.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/lifecycle-chrome', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const HERO_EXPECTED = join(SNAPSHOT_DIR, 'hero.expected.md')
// Post-reload golden: the same settled conversation rebuilt purely from
// persistence + history — byte-equal rendering is exactly the recovery claim.
const RELOADED_EXPECTED = join(SNAPSHOT_DIR, 'reloaded.expected.md')
const MODE = webSnapshotMode()

const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

describe('web e2e: lifecycle & chrome (workspace flow / reload / dark mode)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('sends the first prompt from the empty-state hero (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-send'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    // The blank frame renders the hero, not the resident composer: the
    // headline plus the guidance placeholder are the empty state's anchors.
    await expect.poll(() => page.getByText("Let's start building", { exact: false }).count(), { timeout: 15_000 }).toBe(1)
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    if (MODE !== 'record') {
      // Golden of the hero's stable waiting state (captured before any send;
      // the conversation-region goldens belong to the other scenarios).
      const snapshot = await captureStableAria(page, '[class*="frame"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(HERO_EXPECTED, snapshot, MODE)
    }
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
    }
  }, 200_000)

  it.skipIf(MODE === 'record')('materialized a real Workspace and Session over the wire', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-materialize'))
    // Browser: the sidebar tree now carries the auto-created workspace group
    // with its one session, and the opened session is the selected row.
    await expect.poll(() => page.getByText('1 session', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.getByText('LIGHTHOUSE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    // Host: the session's durable header cwd is the workspace flow's
    // create-by-name target (<workspaceRoot>/workspace, the composer's
    // default draft name) — the proof the send went through workspace
    // materialization rather than a bare default-cwd session.
    const cwds = scaffold.ctx.sessions.list().map(session => session.header.cwd)
    expect(cwds).toEqual([join(scaffold.workspaceCwd, 'workspace')])
    const turnEnds = sessionEvents.filter(e => e.type === 'turn/end')
    expect(turnEnds).toHaveLength(1)
    expect((turnEnds[0] as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind).toBe('completed')
  }, 60_000)

  it.skipIf(MODE === 'record')('recovers the whole surface across a reload from the log alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-reload'))
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    // Selection persisted (dsh.sessions.current) and history replayed: the
    // recorded turn re-renders from session.history with zero model calls —
    // the replay cursor was fully consumed before the reload, so any stray
    // request would fail the scenario loudly at close().
    await expect.poll(() => page.getByText('LIGHTHOUSE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').count(), { timeout: 10_000 }).toBe(1)
    // Golden of the recovered conversation region: rebuilt from the log, it
    // must render the same settled transcript the live turn produced.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(RELOADED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('cascades the dark theme from the body attribute to painted surfaces', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-lifecycle-dark'))
    // This scenario pins the ThemeService's DOM contract seam directly (the
    // body[data-ds-dark-theme] attribute -> stylesheet cascade); the REAL
    // user gesture above it (Settings -> Appearance cubes) is owned by
    // settings-chrome.e2e.ts. Driving the attribute here keeps the cascade
    // pinned independently of the settings surface's own lifecycle.
    const sample = async (): Promise<{ token: string; sidebarBg: string; bodyBg: string }> =>
      await page.evaluate(() => {
        const sidebar = document.querySelector('[class*="sidebar"], [class*="rail"]') ?? document.body
        return {
          token: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
          sidebarBg: getComputedStyle(sidebar).backgroundColor,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        }
      })
    const light = await sample()
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const dark = await sample()
    // The alias token itself must flip — the cascade's root fact.
    expect(dark.token).not.toBe(light.token)
    // And a real painted surface must consume it (not just variables in a
    // void): at least one of the sampled backgrounds repaints.
    expect(dark.sidebarBg !== light.sidebarBg || dark.bodyBg !== light.bodyBg).toBe(true)
    // Removing the attribute restores the light values exactly (the palettes
    // live in one stylesheet; activation is attribute-only by design).
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    const restored = await sample()
    expect(restored).toEqual(light)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'hero.expected.md', 'reloaded.expected.md'])
  })
})
