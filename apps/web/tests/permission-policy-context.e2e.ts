// Web acceptance for current sandbox-policy context. A real Chromium drives
// the shipped /permission command through all three presets; record mode uses
// the real provider, while replay keeps the same provider-authored behavior
// keyless. Assertions read the exact durable request headers and tool calls,
// so assistant prose alone cannot satisfy the scenario.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, recordFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/permission-policy-context', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/permission-policy-context/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()

const PROMPTS = [
  'Can you create or edit a normal file right now under the current policy? Answer directly in one sentence. Do not call a tool just to discover the policy.',
  'Does the DSH file sandbox currently restrict file operations? Answer directly in one sentence. Do not call tools.',
  'Reply with exactly WORKSPACE_POLICY_SEEN. Do not call tools.',
] as const

const PRESET_LABELS = ['Read Only', 'Danger Full Access', 'Workspace Write'] as const

function requestSystems(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'request/header') return []
    return typeof event.data.header.system === 'string' ? [event.data.header.system] : []
  })
}

function assistantTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'assistant/message') return []
    return [event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').replaceAll('**', '')]
  })
}

describe('web e2e: current sandbox policy reaches the model before tools', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionWorkspace: string | undefined
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE })
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      sessionWorkspace = session.header.cwd
      sessionEvents.push(event)
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('switches read-only, danger-full-access, and workspace-write through the real GUI command path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-permission-policy-context'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual(PROMPTS)
    }

    const input = page.locator('textarea').first()
    let sessionId: Awaited<ReturnType<WebScaffold['whenTurnSettled']>> | undefined
    for (const [index, preset] of ['read-only', 'danger-full-access', 'workspace-write'].entries()) {
      await input.fill(`/permission ${preset}`)
      await input.press('Enter')
      await page.getByRole('button', { name: `Access mode, current: ${PRESET_LABELS[index]}` })
        .waitFor({ timeout: 10_000 })

      const settled = scaffold.whenTurnSettled()
      await input.fill(PROMPTS[index] as string)
      await input.press('Enter')
      sessionId = await settled
      await expect.poll(() => input.isEnabled(), { timeout: 10_000 }).toBe(true)
    }

    if (sessionId === undefined) throw new Error('permission-policy scenario completed no model turn')
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 240_000)

  it.skipIf(MODE === 'record')('records each effective policy before the corresponding model behavior', () => {
    const systems = requestSystems(sessionEvents)
    expect(systems).toHaveLength(3)
    expect(systems[0]).toContain('Current DSH file sandbox policy: read-only. Ordinary file writes, edits, and file-mutating shell effects are denied')
    expect(systems[1]).toContain('Current DSH file sandbox policy: danger-full-access. The DSH file sandbox does not restrict file operations.')
    expect(systems[1]).toContain('Approval prompts are disabled in this session')

    if (sessionWorkspace === undefined) throw new Error('permission-policy scenario observed no session workspace')
    const policy = {
      mode: 'workspace-write' as const,
      workspaceRoot: canonicalPath(sessionWorkspace),
    }
    const roots = writableRoots(policy)
    expect(systems[2]).toContain(`Current DSH file sandbox policy: workspace-write. File writes, edits, and file-mutating shell effects are limited to these canonical writable roots: ${roots.map(root => JSON.stringify(root)).join(', ')}.`)
    expect(systems[2]).not.toContain('Approval prompts are disabled in this session')

    const answers = assistantTexts(sessionEvents)
    expect(answers).toHaveLength(3)
    expect(answers[0]).toMatch(/cannot create or edit (?:a )?normal files?|writes?.*denied/i)
    expect(answers[1]).toMatch(/does not.*restrict file operations|not restrict.*file operations/i)
    expect(answers[2]).toBe('WORKSPACE_POLICY_SEEN')
    expect(sessionEvents.filter(event => event.type === 'tool/call')).toHaveLength(0)
  })

  it.skipIf(MODE === 'record')('stays clean and keeps the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
