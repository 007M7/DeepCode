// Keyless browser coverage for pending queue actions through the shipped Web
// composition and real HTTP/SSE wire. A replay override parks the active turn
// so two ordinary follow-ups remain addressable while the page edits one and
// removes one. The queue uses an existing recorded model
// call; this scenario owns only the user-visible mid-turn golden.
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/queue-actions', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const COLLAPSED_EXPECTED = join(SNAPSHOT_DIR, 'collapsed.expected.md')
const EDITING_EXPECTED = join(SNAPSHOT_DIR, 'editing.expected.md')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

const ACTIVE_PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'
const REMOVE = 'Queue item to remove'
const EDIT = 'Queue item to edit'
const EDITED = 'Edited queue item'

describe('web e2e: queue row actions', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let overrideDir: string | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (overrideDir !== undefined) {
      await rm(overrideDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    overrideDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'queue-actions teardown failed')
  })

  it.skipIf(MODE === 'record')('edits and removes exact pending occurrences', async () => {
    overrideDir = await mkdtemp(join(tmpdir(), 'dsh-web-queue-actions-'))
    const readyFile = join(overrideDir, '.hang-ready')
    const overridePath = join(overrideDir, 'replay.override.json')
    await writeFile(overridePath, JSON.stringify({
      patches: [{ at: 0, entry: { kind: 'hang', readyFile } }],
    }))

    const sessionEvents: SessionEvent[] = []
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: overridePath })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-queue-actions'))

    const input = page.locator('textarea').first()
    const settled = scaffold.whenTurnSettled()
    await input.fill(ACTIVE_PROMPT)
    await input.press('Enter')
    await expect.poll(() => existsSync(readyFile), { timeout: 15_000 }).toBe(true)

    for (const text of [REMOVE, EDIT]) {
      await input.fill(text)
      await input.press('Enter')
    }
    const queueHeader = page.getByRole('button', { name: '2 条排队消息' })
    await expect.poll(() => queueHeader.getAttribute('aria-expanded'), { timeout: 10_000 })
      .toBe('false')
    const collapsedSnapshot = await captureStableAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(COLLAPSED_EXPECTED, collapsedSnapshot, MODE)
    await queueHeader.click()
    await expect.poll(
      () => page.getByRole('button', { name: '删除排队消息' }).count(),
      { timeout: 10_000 },
    ).toBe(2)

    const editRow = page.getByText(EDIT, { exact: true }).locator('..')
    await editRow.getByRole('button', { name: '编辑排队消息' }).click()
    const editor = page.getByRole('textbox', { name: '编辑排队消息' })
    await editor.fill(EDITED)
    const editingSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EDITING_EXPECTED, editingSnapshot, MODE)
    await page.getByRole('button', { name: '保存排队消息' }).click()
    await page.getByText(EDITED, { exact: true }).waitFor()

    const removeRow = page.getByText(REMOVE, { exact: true }).locator('..')
    await removeRow.getByRole('button', { name: '删除排队消息' }).click()
    await expect.poll(() => page.getByText(REMOVE, { exact: true }).count()).toBe(0)

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(sessionEvents.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

    const editedRow = page.getByText(EDITED, { exact: true }).locator('..')
    await editedRow.getByRole('button', { name: '删除排队消息' }).click()
    await expect.poll(() => page.getByText(EDITED, { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Stop generating' }).click()
    await settled
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(
      SNAPSHOT_DIR,
      ['collapsed.expected.md', 'editing.expected.md', 'ui.expected.md'],
    )
  })
})
