// Web e2e scenarios: workspace management — the create-by-name dialog, the
// rename round trip over the real wire (workspace.rename RPC + durable
// registry), duplicate-name pre-check, the flat "In one list" view with its
// persisted group-by preference, and the session hover card. Zero model
// calls: workspace.create/rename are host RPCs with no model involvement,
// and the one session row the flat/hover scenarios need comes from a seeded
// fixture (the seeded-history seed reused verbatim — no new recording).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-management', import.meta.url))
// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold session row, not new recorded content.
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const BROWSER_EXPECTED = join(SNAPSHOT_DIR, 'directory-browser.expected.md')
const SEED_ID = 'workspace-management-web-e2e'

describe('web e2e: workspace management (create / rename / flat view / hover card)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * Drive the in-app browser to a directory via its path-edit affordance,
   * confirm it, and wait for the adoption to settle host-side (workspace
   * registered + the flow's New-Session agent up), so later test steps can't
   * race the in-flight blank-session attach.
   */
  async function openLocalFolder(path: string, options: { waitForAgent?: boolean } = {}): Promise<void> {
    const agentsBefore = scaffold.ctx.agents.list().length
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await page.getByRole('menuitem', { name: 'Open local folder…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    await dialog.getByLabel('Edit path').fill(path)
    await dialog.getByLabel('Edit path').press('Enter')
    await dialog.getByRole('button', { name: 'Open' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    await expect.poll(
      () => scaffold.ctx.workspace.resolveByPath(path),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    // First adoption births a blank Session+Agent whose workspace attach must
    // settle before a test may delete the registration; the reuse path (same
    // canonical cwd already has a blank session) creates no agent, so callers
    // opt in only where a fresh attach is possible.
    if (options.waitForAgent === true) {
      await expect.poll(() => scaffold.ctx.agents.list().length, { timeout: 10_000 })
        .toBeGreaterThan(agentsBefore)
    }
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session (Ungrouped bucket) for the flat view + hover card.
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
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

  it('deletes only the Workspace registration and keeps its current Session, folder, and log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-delete'))
    const slotConsoleErrors: string[] = []
    const transientSlotErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        slotConsoleErrors.push(message.text())
      }
    })
    await page.exposeFunction('recordDshSlotError', (key: string) => {
      if (!transientSlotErrors.includes(key)) transientSlotErrors.push(key)
    })
    await page.evaluate(() => {
      const target = window as unknown as { recordDshSlotError(key: string): Promise<void> }
      const seen = new Set<string>()
      const collect = (): void => {
        for (const node of document.querySelectorAll<HTMLElement>('[data-slot-error]')) {
          const key = node.dataset.slotError ?? ''
          if (!seen.has(key)) {
            seen.add(key)
            void target.recordDshSlotError(key)
          }
        }
      }
      new MutationObserver(collect).observe(document.documentElement, { childList: true, subtree: true })
      collect()
    })
    // Register the scaffold's existing project directory through the real UI.
    await openLocalFolder(scaffold.workspaceCwd, { waitForAgent: true })
    const workspace = await scaffold.ctx.workspace.resolveByPath(scaffold.workspaceCwd)
    if (workspace === undefined) throw new Error('GUI did not register the existing project directory')
    await workspace.attachSession(SessionId(SEED_ID))
    const header = (await scaffold.ctx.sessionPersistence.list())
      .find(candidate => candidate.id === SEED_ID)
    if (header === undefined) throw new Error('seeded Session log disappeared before deletion')
    const logLocation = scaffold.ctx.sessionPersistence.locate(header)
    if (logLocation === undefined) throw new Error('JSONL persistence did not expose the seeded log path')
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)

    // Open the seeded (first/accounted) Session so deletion must preserve the
    // current selection while it moves into Ungrouped.
    const groupRow = page.locator('[role="treeitem"]').filter({ hasText: workspace.title }).first()
    await groupRow.waitFor({ timeout: 10_000 })
    // The header row is wrapped by its HoverCard anchor span, so the section
    // is the nearest groupSection ancestor, not the immediate parent.
    const groupSection = groupRow.locator('xpath=ancestor::*[contains(@class, "groupSection")][1]')
    if (await groupSection.locator('[role="treeitem"]').count() < 2) await groupRow.click()
    await expect.poll(
      () => groupSection.locator('[role="treeitem"]').count(),
      { timeout: 10_000 },
    ).toBeGreaterThanOrEqual(2)
    const seededRow = groupSection.locator('[role="treeitem"]').nth(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    await groupRow.hover()
    await page.getByRole('button', { name: `Workspace actions for ${workspace.title}` }).click()
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete workspace' })
    await dialog.waitFor({ timeout: 10_000 })
    const copy = await dialog.textContent()
    expect(copy).toContain('workspace list')
    expect(copy).toContain('folder and session logs will be kept')
    expect(copy).toContain('sessions will appear under Ungrouped')
    await dialog.getByRole('button', { name: 'Delete workspace' }).click()
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)

    expect(scaffold.ctx.workspace.get(workspace.id)).toBeUndefined()
    await expect.poll(
      () => page.getByRole('button', { name: `Workspace actions for ${workspace.title}` }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)
    expect((await scaffold.ctx.sessionPersistence.inspect(SessionId(SEED_ID))).events.length).toBeGreaterThan(0)

    // Re-registering the exact deleted path immediately, without a reload, is
    // a supported reversible flow. It creates a fresh Workspace id without
    // re-adopting the retained Session.
    await openLocalFolder(scaffold.workspaceCwd)
    await expect.poll(
      () => scaffold.ctx.workspace.resolveByPath(scaffold.workspaceCwd),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    const reregistered = await scaffold.ctx.workspace.resolveByPath(scaffold.workspaceCwd)
    expect(reregistered?.id).toBeDefined()
    expect(reregistered?.id).not.toBe(workspace.id)
    expect(reregistered?.sessionIds).toEqual([])
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)

    // Restore the deleted-registry state so reload still verifies deletion
    // persistence independently of the successful re-registration above.
    if (reregistered === undefined) throw new Error('same-path re-registration did not materialize')
    await scaffold.ctx.workspace.delete(reregistered.id)
    await expect.poll(
      () => page.getByRole('button', { name: `Workspace actions for ${reregistered.title}` }).count(),
      { timeout: 10_000 },
    ).toBe(0)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 15_000 },
    ).toBe(1)
    expect(scaffold.ctx.workspace.get(workspace.id)).toBeUndefined()
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'a.txt'), 'utf8')).toBe('alpha\n')
    await stat(logLocation.path)
    expect((await scaffold.ctx.sessionPersistence.inspect(SessionId(SEED_ID))).events.length).toBeGreaterThan(0)

    expect(transientSlotErrors).toEqual([])
    expect(slotConsoleErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('reuses a deleted title for a different new directory without any transient error surface', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-reuse-title'))
    const title = 'same-name'
    const oldPath = join(scaffold.workspaceCwd, 'adopted', title)
    await mkdir(oldPath, { recursive: true })
    const transientErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.exposeFunction('recordDshTransientWorkspaceError', (message: string) => {
      if (!transientErrors.includes(message)) transientErrors.push(message)
    })
    await page.evaluate(() => {
      const target = window as unknown as {
        recordDshTransientWorkspaceError(message: string): Promise<void>
      }
      const collect = (): void => {
        for (const node of document.querySelectorAll<HTMLElement>('[data-slot-error], [role="alert"]')) {
          const message = node.dataset.slotError ?? node.textContent?.trim() ?? ''
          if (message !== '') void target.recordDshTransientWorkspaceError(message)
        }
      }
      new MutationObserver(collect).observe(document.documentElement, { childList: true, subtree: true })
      collect()
    })

    await openLocalFolder(oldPath)
    await expect.poll(
      () => scaffold.ctx.workspace.resolveByPath(oldPath),
      { timeout: 10_000 },
    ).not.toBeUndefined()
    const oldWorkspace = await scaffold.ctx.workspace.resolveByPath(oldPath)
    if (oldWorkspace === undefined) throw new Error('old same-name Workspace was not registered')

    const oldRow = page.locator('[role="treeitem"]').filter({ hasText: title }).first()
    await oldRow.hover()
    await page.getByRole('button', { name: `Workspace actions for ${title}` }).click()
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click()
    await page.getByRole('dialog', { name: 'Delete workspace' })
      .getByRole('button', { name: 'Delete workspace' }).click()
    await expect.poll(() => scaffold.ctx.workspace.get(oldWorkspace.id), { timeout: 10_000 }).toBeUndefined()

    await page.getByRole('button', { name: 'Create workspace' }).click()
    await page.getByRole('menuitem', { name: 'Create a new workspace' }).click()
    const create = page.getByRole('dialog', { name: 'Create a new workspace' })
    await create.getByLabel('New workspace name').fill(title)
    await create.getByRole('button', { name: 'Create workspace' }).click()
    await expect.poll(() => create.count(), { timeout: 10_000 }).toBe(0)
    const fresh = scaffold.ctx.workspace.list().find(workspace => workspace.title === title)
    expect(fresh?.id).toBeDefined()
    expect(fresh?.id).not.toBe(oldWorkspace.id)
    expect(fresh?.path).toBe(join(scaffold.workspaceCwd, title))
    expect(transientErrors).toEqual([])
    expect(consoleErrors).toEqual([])
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

  it('matches the directory-browser dialog aria golden at a staged directory', async () => {
    // A staged subtree under the scaffold cwd keeps the listing deterministic
    // (normalizeAria scrubs the cwd), and pointing the in-process host's HOME
    // at the cwd collapses the breadcrumb ancestry into the Home crumb — no
    // machine-specific path segments or real $HOME contents enter the golden.
    const staged = join(scaffold.workspaceCwd, 'browse-golden')
    await mkdir(join(staged, 'alpha'), { recursive: true })
    await mkdir(join(staged, 'beta'), { recursive: true })
    // homedir() reads HOME on POSIX and USERPROFILE on Windows: root both
    // at the scaffold cwd so the golden's ancestry collapses everywhere.
    const realHome = process.env.HOME
    const realUserProfile = process.env.USERPROFILE
    process.env.HOME = scaffold.workspaceCwd
    process.env.USERPROFILE = scaffold.workspaceCwd
    try {
      await page.getByRole('button', { name: 'Create workspace' }).click()
      await page.getByRole('menuitem', { name: 'Open local folder…' }).click()
      const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'Edit path' }).click()
      await dialog.getByLabel('Edit path').fill(staged)
      await dialog.getByLabel('Edit path').press('Enter')
      await expect.poll(() => dialog.getByText('alpha', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
      const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(BROWSER_EXPECTED, snapshot, MODE)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    } finally {
      if (realHome === undefined) delete process.env.HOME
      else process.env.HOME = realHome
      if (realUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = realUserProfile
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('shows the session hover card after a dwell on the row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-hover'))
    // Expand Ungrouped to reveal the seeded session row, then dwell on it
    // (the card opens after a 500ms hover delay, portaled to body).
    const ungroupedRow = page.getByText('Ungrouped', { exact: true }).locator('..').locator('..')
    const ungroupedSection = ungroupedRow.locator('..')
    // Initial-current auto-expansion can race this following test's gesture;
    // converge on expanded rather than assuming which update wins first.
    await expect.poll(async () => {
      if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') {
        await page.getByText('Ungrouped', { exact: true }).click()
        await page.waitForTimeout(50)
      }
      return await ungroupedRow.getAttribute('aria-expanded')
    }, { timeout: 5_000 }).toBe('true')
    // The only visible child is the non-blank persisted Session; the blank
    // Session created while adopting the Workspace remains hidden.
    const sessionRow = ungroupedSection.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.hover()
    // Card content: the full title plus the Idle status line (display-only
    // card; no aria role — text anchors are the stable selector).
    await expect.poll(() => page.getByText('Idle', { exact: true }).count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
    // Leaving the anchor closes it with no delay.
    await page.getByRole('button', { name: 'Settings' }).hover()
    await expect.poll(() => page.getByText('Idle', { exact: true }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    expect(tripwire.warnings).toEqual([])
    // The directory-browser aria golden is this spec's one owned artifact;
    // the seed it reuses is owned (and inventory-guarded) by seeded-history.
    await assertFixtureInventory(SNAPSHOT_DIR, ['.gitkeep', 'directory-browser.expected.md'])
  })
})
