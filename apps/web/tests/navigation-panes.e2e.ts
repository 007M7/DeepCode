// Web e2e scenarios: navigation & panes — the view tabs (Trajectory /
// Waterfall) and sidebar search, all over ONE rich two-turn seeded fixture
// rendered purely from the log (the seeded-history pattern: zero model calls
// in replay, so every surface here is the client fold + host history RPC,
// not replay binding). The seed is recorded live under the standard
// discipline: turn 1 produces a bash call plus two parallel reads in one
// assistant message (tool-call density for the trajectory/waterfall lanes),
// turn 2 a markdown-rich reply (a second turn so the waterfall has two lanes).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/navigation-panes', import.meta.url))
const SEED = join(SNAPSHOT_DIR, 'seed.jsonl')
const TRAJECTORY_EXPECTED = join(SNAPSHOT_DIR, 'trajectory.expected.md')
const WATERFALL_EXPECTED = join(SNAPSHOT_DIR, 'waterfall.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'navigation-panes-web-e2e'

// Turn 1 leads with a distinctive word: the session-title fallback takes the
// first words of the first message, so the sidebar-search scenario has a
// known-matching query ('navscenario') without depending on a live title call.
const PROMPT_TURN1 = 'NavScenario: first run bash to print exactly NAVIGATION_OK, then read nav-a.md and nav-b.md using two read calls in ONE assistant message, then reply with the single word FIRST_DONE and stop.'
const PROMPT_TURN2 = 'Reply in markdown with: a level-2 heading "Navigation Summary", a bulleted list of exactly two items, and a fenced code block containing echo WATERFALL. Then stop.'

describe('web e2e: navigation & panes over a rich seeded session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The workspace-aware flow runs sessions in <workspaceRoot>/workspace;
    // the read targets must live in that session cwd (pre-creation is safe:
    // create-by-name adopts an existing directory).
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'nav-a.md'), '# alpha nav\n')
    await writeFile(join(sessionCwd, 'nav-b.md'), '# beta nav\n')
    if (MODE !== 'record') {
      const raw = await readFile(SEED, 'utf8')
      expect(fixtureUserPrompts(raw), 'seed fixture must carry exactly the two drive prompts')
        .toEqual([PROMPT_TURN1, PROMPT_TURN2])
      await seedSession(scaffold, raw, SEED_ID)
    }
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE !== 'record')('records the two-turn seed live through the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-record'))
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    let sessionId: Awaited<ReturnType<WebScaffold['whenTurnSettled']>> | undefined
    for (const prompt of [PROMPT_TURN1, PROMPT_TURN2]) {
      const settled = scaffold.whenTurnSettled()
      // Turn 2 types into the same composer once turn 1 unlocks it.
      await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)
      await input.fill(prompt)
      await input.press('Enter')
      sessionId = await settled
    }
    await recordFixture(scaffold, sessionId!, SEED)
    // Fixture honesty: the recording must carry the shape the replay
    // scenarios assert on — three calls in turn 1 and two closed turns.
    const recorded = parseSessionLog(await readFile(SEED, 'utf8'))
    expect(recorded.filter(e => e.type === 'turn/end')).toHaveLength(2)
    const calls = recorded.filter((e): e is SessionEvent & { data: { name: string } } => e.type === 'tool/call')
    expect(calls.map(e => e.data.name).sort()).toEqual(['bash', 'read', 'read'])
  }, 400_000)

  it.skipIf(MODE === 'record')('opens the seeded session and renders both turns from the log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-open'))
    // Expand the collapsed group row, then open the revealed session row.
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText('FIRST_DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByRole('heading', { name: 'Navigation Summary' }).count(), { timeout: 15_000 }).toBe(1)
  }, 90_000)

  it.skipIf(MODE === 'record')('filters the sidebar tree by title through the search box', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-search'))
    // Runs after the session is open: a cold summary carries no title (the
    // sidebar shows the cwd basename), and the durable title lands with the
    // attach subscription's baseline — which is itself worth pinning: search
    // matches the title the user sees, not a hidden cold field.
    const search = page.getByPlaceholder('Search name, keywords', { exact: false })
    await expect.poll(() => page.getByText('NavScenario', { exact: false }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    // Negative: a garbage query empties the tree (group rows hide too).
    await search.fill('zzzqx-no-such-session')
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBe(0)
    // Positive: a title word narrows to the matched session + its group,
    // force-expanded by search mode (case-insensitive client-side filter).
    await search.fill('navscenario')
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    // Clear restores the unfiltered tree.
    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect.poll(() => search.inputValue(), { timeout: 5_000 }).toBe('')
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it.skipIf(MODE === 'record')('renders the trajectory tab with turn sections and step cells', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-trajectory'))
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    // Two sticky turn sections; turn 1's step group summarizes its tool mix
    // (bash + the two parallel reads collapse to 'bash read×2').
    await expect.poll(() => page.getByText('Turn 1', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => page.getByText('Turn 2', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.getByText('bash read×2', { exact: false }).count(), { timeout: 10_000 }).toBe(1)
    const snapshot = (await captureStableAria(page, '[class*="viewArea"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TRAJECTORY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it.skipIf(MODE === 'record')('renders the waterfall tab with span stats and one lane per span', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-waterfall'))
    await page.getByRole('tab', { name: 'Waterfall' }).click()
    // The stats header rides the waterfall body. The span fold counts THREE
    // spans for this two-turn log: only assistant/steering nodes carry a turn
    // number, so the first user message lands in a turn-0 prologue span (a
    // P-I placeholder shape — pinned as-is; real spans are deferred to
    // P-III per the view's deviation ledger). Calls: bash + two reads.
    await expect.poll(() => page.getByText(/3 turns · \d+ steps · 3 tool calls/).count(), { timeout: 15_000 }).toBe(1)
    // One lane per span, tagged by turn number, prologue included.
    for (const tag of ['turn 0', 'turn 1', 'turn 2']) {
      await expect.poll(() => page.getByText(tag, { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    }
    const snapshot = (await captureStableAria(page, '[class*="viewArea"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(WATERFALL_EXPECTED, snapshot, MODE)
  }, 60_000)

  it.skipIf(MODE === 'record')('bash and file-path rows leave the details column collapsed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-details'))
    await page.getByRole('tab', { name: 'Chat' }).click()
    const bashRow = page.locator('[data-sample="bash-global"]').first()
    await bashRow.waitFor({ timeout: 15_000 })
    const frame = page.locator('[data-details-collapsed], [class*="frame"]').first()
    expect(await frame.getAttribute('data-details-collapsed')).not.toBeNull()
    await bashRow.click()
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).not.toBeNull()
    // Read summaries are host-open file links; they also must not open details.
    const fileLink = page.locator('[data-variant="read"] button').first()
    await fileLink.waitFor({ timeout: 10_000 })
    await fileLink.click()
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).not.toBeNull()
  }, 60_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'seed.jsonl', 'trajectory.expected.md', 'waterfall.expected.md',
    ])
  })
})
