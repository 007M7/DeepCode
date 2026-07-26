// Web e2e scenarios: workspace management — the create-by-name dialog, the
// rename round trip over the real wire (workspace.rename RPC + durable
// registry), duplicate-name pre-check, the flat "In one list" view with its
// persisted group-by preference, and the session hover card. Zero model
// calls: workspace.create/rename are host RPCs with no model involvement,
// and the one session row the flat/hover scenarios need comes from a seeded
// fixture (the seeded-history seed reused verbatim — no new recording).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-management', import.meta.url))
// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold session row, not new recorded content.
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'workspace-management-web-e2e'

describe('web e2e: workspace management (create / rename / flat view / hover card)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session (Ungrouped bucket) for the flat view + hover card.
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
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

  it('creates two workspaces by name through the region-header dialog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-create'))
    const createByName = async (name: string): Promise<void> => {
      await page.getByRole('button', { name: 'Create workspace' }).click()
      // The pick menu's Create workspace submenu opens on hover/focus.
      await page.getByRole('menuitem', { name: 'Create workspace' }).hover()
      await page.getByRole('menuitem', { name: 'Create a new workspace' }).click()
      const dialog = page.getByRole('dialog', { name: 'Create a new workspace' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByLabel('New workspace name').fill(name)
      await dialog.getByRole('button', { name: 'Create workspace' }).click()
      await expect.poll(() => page.getByRole('dialog', { name: 'Create a new workspace' }).count(), { timeout: 10_000 }).toBe(0)
      // The real workspace materializes in the tree as a group row.
      await expect.poll(() => page.getByText(name, { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    }
    await createByName('alpha-ws')
    await createByName('beta-ws')
    // Durable on the host: both registered, newest first (create prepends).
    const titles = scaffold.ctx.workspace.list().map(workspace => workspace.title)
    expect(titles.slice(0, 2)).toEqual(['beta-ws', 'alpha-ws'])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('renames a workspace over the wire with a duplicate-name pre-check', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-rename'))
    // The actions button is display:none until its row hovers — hover the
    // group row first, then the revealed button becomes actionable.
    await page.locator('[role="treeitem"]').filter({ hasText: 'alpha-ws' }).first().hover()
    await page.getByRole('button', { name: 'Workspace actions for alpha-ws' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename workspace' })
    await dialog.waitFor({ timeout: 10_000 })
    const input = dialog.getByLabel('Workspace name')
    // Client pre-check: a name colliding with another live workspace raises
    // the inline alert and blocks the primary button before any wire call.
    await input.fill('beta-ws')
    await expect.poll(() => dialog.getByRole('alert').count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByRole('button', { name: 'Rename' }).isDisabled()).toBe(true)
    // A fresh name goes through workspace.rename to the durable registry.
    await input.fill('gamma-ws')
    await expect.poll(() => dialog.getByRole('alert').count(), { timeout: 5_000 }).toBe(0)
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Rename workspace' }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('gamma-ws', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.getByText('alpha-ws', { exact: true }).count()).toBe(0)
    // Host durability, then reload: the projection is rebuilt from the wire.
    expect(scaffold.ctx.workspace.list().map(workspace => workspace.title)).toContain('gamma-ws')
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('gamma-ws', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('switches to the flat "In one list" view and persists the preference', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-flat'))
    // Grouped default: workspace group rows render (the seeded session sits
    // under Ungrouped; the created workspaces are empty groups).
    await expect.poll(() => page.getByText('Workspaces', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await page.getByRole('button', { name: 'Group by' }).click()
    await page.getByRole('menuitem', { name: 'In one list' }).click()
    // Flat mode: the section label flips and the seeded session is a
    // top-level row with no group headers above it.
    await expect.poll(() => page.getByText('Sessions', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.evaluate(() => localStorage.getItem('dsh.workspace.view'))).toContain('flat')
    // Persisted across reload; then restore grouped for inter-spec hygiene.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 15_000 }).toBe(0)
    await page.getByRole('button', { name: 'Group by' }).click()
    await page.getByRole('menuitem', { name: 'WorkSpace' }).click()
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('shows the session hover card after a dwell on the row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-hover'))
    // Expand Ungrouped to reveal the seeded session row, then dwell on it
    // (the card opens after a 500ms hover delay, portaled to body).
    await page.getByText('Ungrouped', { exact: true }).click()
    // A cold summary carries no durable title, so the row falls back to a
    // cwd-derived display title — anchored on the run-local workspace-root
    // basename rather than a literal.
    const wsBase = scaffold.workspaceCwd.split('/').pop()!
    const sessionRow = page.locator('[role="treeitem"]').filter({ hasText: wsBase }).first()
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.hover()
    // Card content: the full title plus the Idle status line (display-only
    // card; no aria role — text anchors are the stable selector).
    await expect.poll(() => page.getByText('Idle', { exact: true }).count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
    // Leaving the anchor closes it with no delay.
    await page.getByRole('button', { name: '设置' }).hover()
    await expect.poll(() => page.getByText('Idle', { exact: true }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    expect(tripwire.warnings).toEqual([])
    // This spec mints no fixture directory contents of its own; the seed it
    // reuses is owned (and inventory-guarded) by seeded-history.
    await assertFixtureInventory(SNAPSHOT_DIR, ['.gitkeep'])
  })
})
