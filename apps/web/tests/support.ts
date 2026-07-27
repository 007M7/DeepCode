// Shared plumbing for the web smoke tests (dist location, free port, failure shots).
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'

/** The built page under test; `pnpm run test:web` rebuilds it before running. */
export const DIST_INDEX = fileURLToPath(new URL('../dist/index.html', import.meta.url))

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Fail loud on a stale checkout instead of testing yesterday's bundle. */
export function requireDist(): void {
  if (!existsSync(DIST_INDEX)) {
    throw new Error('web app dist not built — run `pnpm --filter @deepseek-ai/dsh-frontend build` (pnpm run test:web does this first)')
  }
}

/** OS-assigned free port, released before use (the spawned `dsh web` needs a concrete --port). */
export function probeFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('port probe returned no address')) })
        return
      }
      probe.close(() => { resolvePort(address.port) })
    })
  })
}

/**
 * Drive the hero's workspace picker through its create-by-name dialog until
 * the live composer unlocks. A fresh world has no Workspace, so the boot
 * lands in the locked view state (startup auto-selection has nothing to
 * select); every scenario that types into the composer must connect one
 * first. The default name 'workspace' keeps the session header cwd at
 * <workspaceRoot>/workspace — the materialization proof several scenarios
 * assert.
 * @param page - the page under test.
 * @param name - workspace name typed into the create dialog.
 */
export async function connectFreshWorkspace(page: Page, name = 'workspace'): Promise<void> {
  await page.getByRole('button', { name: 'Choose workspace' }).click()
  await page.getByRole('menuitem', { name: 'Create workspace' }).hover()
  await page.getByRole('menuitem', { name: 'Create a new workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a new workspace' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByLabel('New workspace name').fill(name)
  await dialog.getByRole('button', { name: 'Create workspace' }).click()
  // The pick connected the workspace: the blank session's live composer
  // replaces the locked placeholder and enables.
  await page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    .waitFor({ timeout: 15_000 })
}

/** Failure evidence goes to the gitignored .artifacts/ (repo convention). */
export async function saveFailureShot(page: Page, name: string): Promise<void> {
  const dir = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
  mkdirSync(dir, { recursive: true })
  try {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
  } catch {
    // Best-effort evidence: a dead page/browser at failure time must not mask the real assertion error.
  }
}
