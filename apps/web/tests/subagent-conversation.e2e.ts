import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  SESSION_FORMAT_VERSION, SessionId as sessionId, type SessionEvent, type SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const BASE_FIXTURE = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/subagent-conversation/ui.expected.md', import.meta.url))
const TREE_EXPECTED = fileURLToPath(new URL('./snapshots/subagent-conversation/tree.expected.md', import.meta.url))
const SIDEBAR_EXPECTED = fileURLToPath(new URL('./snapshots/subagent-conversation/sidebar.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const LABEL = 'event-sourcing researcher'
const NESTED_LABEL = 'example editor'
const PARENT_PROMPT = 'Ask a research subagent to explain event sourcing.'
const INITIAL_PROMPT = 'Explain event sourcing in one sentence.'
const FOLLOWUP = 'Now give the same explanation to a human reader.'

function childFixture(source: string, fixtureId: string, withContinuation: boolean): string {
  const [header, ...eventLines] = source.trimEnd().split('\n')
  if (header === undefined) throw new Error('base replay fixture has no header')
  const childHeader = header
    .replace('"id":"{{sessionId}}"', `"id":"${fixtureId}"`)
    .replace(/"createdAt":\d+/, '"createdAt":1784998084442')
  if (!withContinuation) return [childHeader, ...eventLines, ''].join('\n')
  const continued = eventLines.map(line => line
    .replace(/"seq":(\d+)/g, (_match, seq: string) => `"seq":${String(Number(seq) + 100)}`)
    .replace(/"seq0":(\d+)/g, (_match, seq: string) => `"seq0":${String(Number(seq) + 100)}`)
    .replaceAll('"turn":1', '"turn":2'))
  return [childHeader, ...eventLines, ...continued, ''].join('\n')
}

describe('web e2e: persisted subagent conversation and human continuation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sidecarRoot: string
  let childId: SessionId
  let grandchildId: SessionId
  let tripwire: ReturnType<typeof watchConsole>
  const apiCalls: string[] = []

  beforeAll(async () => {
    if (MODE === 'record') throw new Error('subagent conversation is a keyless assembled snapshot')
    const baseFixture = await readFile(BASE_FIXTURE, 'utf8')
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-subagent-'))
    const childFixturePath = join(sidecarRoot, 'child.jsonl')
    await writeFile(childFixturePath, childFixture(baseFixture, 'recorded-subagent', true))
    scaffold = await launchWebScaffold({
      replayFixture: BASE_FIXTURE,
      replayChildFixtures: [childFixturePath],
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/')) apiCalls.push(path)
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page)

    const parent = scaffold.ctx.agents.roots()[0]
    if (parent === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    const parentSettled = scaffold.whenTurnSettled()
    const parentInput = page.locator('textarea:enabled').first()
    await parentInput.fill(PARENT_PROMPT)
    await parentInput.press('Enter')
    expect(await parentSettled).toBe(parent.id)

    const started = await scaffold.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: LABEL,
      signal: new AbortController().signal,
      request: {
        prompt: [{ type: 'text', text: INITIAL_PROMPT }],
        parent,
      },
    })
    childId = started.childId
    await expect.poll(
      () => scaffold.ctx.agents.get(childId),
      { timeout: 30_000 },
    ).toBeUndefined()
    grandchildId = sessionId('recorded-grandchild')
    const authoredAt = Date.now()
    await scaffold.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: grandchildId,
      createdAt: authoredAt,
      cwd: scaffold.workspaceCwd,
      parentSession: childId,
      delegationDepth: 2,
    })
    await scaffold.ctx.sessionPersistence.append(grandchildId, [
      {
        type: 'turn/start',
        seq: 0,
        time: authoredAt,
        data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
      },
      {
        type: 'user/message',
        seq: 1,
        time: authoredAt + 1,
        data: {
          content: [{ type: 'text', text: 'Give one concrete event sourcing example.' }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      },
      {
        type: 'subagent/descriptor',
        seq: 2,
        time: authoredAt + 2,
        data: snapshotSubagentDescriptor({ provider: 'spawn', label: NESTED_LABEL }),
      },
      {
        type: 'turn/end',
        seq: 3,
        time: authoredAt + 3,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    ] as SessionEvent[])
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    await expect(scaffold.ctx.subagents.listChildren(parent.id)).resolves.toMatchObject([
      { kind: 'child', id: childId, label: LABEL, activity: 'inactive' },
    ])
    await expect(scaffold.ctx.subagents.listChildren(childId)).resolves.toMatchObject([
      { kind: 'child', id: grandchildId, label: NESTED_LABEL, activity: 'inactive' },
    ])
    await page.getByRole('button', { name: '1 个子代理' }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (sidecarRoot !== undefined) {
      await rm(sidecarRoot, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'subagent Web teardown failed')
  })

  it('expands a persisted grandchild progressively without activating either level', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-tree'))
    await page.getByRole('button', { name: '1 个子代理' }).click()
    await page.getByRole('button', { name: `展开 ${LABEL} 的下级子代理` }).click()
    await page.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).waitFor({ timeout: 15_000 })
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(grandchildId)).toBeUndefined()
    const snapshot = await captureStableAria(
      page,
      '[role="tree"][aria-label="子代理会话"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(TREE_EXPECTED, snapshot, MODE)
    await page.getByRole('tree', { name: '子代理会话' }).press('Escape')
  })

  it('opens the completed child from persistence without activating it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-open'))
    await page.getByRole('button', { name: '1 个子代理' }).click()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) }).click()
    await expect.poll(
      () => page.getByText(INITIAL_PROMPT, { exact: true }).count(),
      { timeout: 15_000 },
    ).toBe(1)
    if (scaffold.ctx.agents.get(childId) !== undefined) {
      throw new Error(`viewing the child activated it; API calls: ${apiCalls.join(', ')}`)
    }
    await page.getByRole('heading', { name: LABEL }).waitFor()
    const sidebar = await captureStableAria(
      page,
      '[role="tree"][aria-label="Sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(SIDEBAR_EXPECTED, sidebar, MODE)
  })

  it('continues through a cold-resumed Activation and receives the child mux events', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-followup'))
    const ended = new Promise<void>((resolveEnded, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('subagent follow-up did not reach turn/end'))
      }, 30_000)
      const off = scaffold.ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
        if (session.id !== childId || event.type !== 'turn/end') return
        clearTimeout(timer)
        off()
        resolveEnded()
      })
    })
    const input = page.locator('textarea:enabled').first()
    await input.fill(FOLLOWUP)
    await input.press('Enter')
    await ended
    await expect.poll(() => page.getByText(FOLLOWUP, { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => scaffold.ctx.agents.get(childId), { timeout: 10_000 }).toBeUndefined()
    expect(await page.getByRole('button', { name: 'Stop generating' }).count()).toBe(0)
  })

  it('matches the settled addressed-conversation aria golden and stays clean', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-aria'))
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
