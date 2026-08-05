// Keyless assembled-browser evidence for the opt-in Schedule overlay. A real
// root Agent receives schedule_create through the complete tool pipeline; the
// one-second owner path queues its best-effort followup, commits dispatch, and
// the browser renders the Host's durability-gated reminder sidecar. No model
// fixture is installed: the later prompt failure cannot retract the receipt.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('../../../examples/web-schedule/cordis.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/schedule-after', import.meta.url))
const RECEIPT_EXPECTED = fileURLToPath(new URL('./snapshots/schedule-after/receipt.expected.md', import.meta.url))
const PROMPT = 'Check the deployment log'

interface CreatedScheduleView {
  id: string
  deliveryMode: 'session-local'
}

/** Wait for one in-process lifecycle fact without using test-scoped expect.poll in beforeAll. */
async function waitForFact(read: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!read()) {
    if (Date.now() >= deadline) throw new Error(`Schedule lifecycle fact did not arrive within ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe.skipIf(MODE === 'record')('web e2e: durable after reminder receipt', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let browser: Browser
  let page: Page
  let scheduleId = ''
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('schedule-after-web-e2e'),
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const workspace = await scaffold.ctx.workspace.create(scaffold.workspaceCwd, 'Schedule')
    await workspace.attachSession(agentHandle.agent.id)

    const created = await scaffold.ctx.tools.execute({
      signal: AbortSignal.timeout(10_000),
      callId: CallId('schedule-after-create'),
      name: 'schedule_create',
      arguments: { prompt: PROMPT, after_seconds: 1 },
      agent: agentHandle.agent,
    })
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error(created.error.message)
    const value = created.value as unknown as CreatedScheduleView
    expect(value.deliveryMode).toBe('session-local')
    scheduleId = value.id
    expect(scheduleId.length).toBeGreaterThan(0)

    await waitForFact(() => agentHandle.agent.session.events.some(event =>
      event.type === 'schedule/change'
      && (event.data as { operation?: unknown }).operation === 'dispatch'), 15_000)
    await expect(scaffold.ctx.sessions.flush(agentHandle.agent.session)).resolves.toBe(true)
    const durable = await scaffold.ctx.sessionPersistence.inspect(agentHandle.agent.id)
    expect(durable.meta).toMatchObject(agentHandle.agent.session.header)
    expect({ ...durable.meta, delegationDepth: durable.meta.delegationDepth ?? 0 }).toEqual({
      ...agentHandle.agent.session.header,
      delegationDepth: agentHandle.agent.session.header.delegationDepth ?? 0,
    })
    expect(durable.events).toEqual(agentHandle.agent.session.events.slice(0, durable.events.length))
    const history = await scaffold.ctx.apiProxy.sessions.history({
      rpcId: RpcId('schedule-history-baseline'), payload: { sessionId: agentHandle.agent.id },
    })
    if (!history.result.ok) throw new Error(history.result.error.message)
    expect(history.result.value.events?.find(entry =>
      entry.event.type === 'schedule/change'
      && (entry.event.data as { operation?: unknown }).operation === 'dispatch')?.view).toMatchObject({
      for: 'event', presentationKey: 'schedule/reminder',
    })
    await waitForFact(
      () => agentHandle.agent.session.events.some(event => event.type === 'turn/start'),
      10_000,
    )
    const listed = await scaffold.ctx.apiProxy.sessions.list({
      rpcId: RpcId('schedule-list-baseline'), payload: {},
    })
    if (!listed.result.ok) throw new Error(listed.result.error.message)
    expect(listed.result.value.items.find(item => item.sessionId === agentHandle.agent.id)?.blank).toBe(false)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Schedule Web evidence teardown failed')
  })

  it('renders the committed reminder from attached history', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-schedule-after'))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') {
      await group.evaluate((element) => { (element as HTMLElement).click() })
    }
    await expect.poll(() => group.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')
    const session = page.locator('[role="treeitem"][aria-selected]').nth(1)
    await session.waitFor({ timeout: 10_000 })
    await session.click()

    const receipt = page.locator('[data-schedule-reminder]')
    await receipt.waitFor({ timeout: 15_000 })
    expect(await receipt.getByText(PROMPT, { exact: true }).count()).toBe(1)
    expect(await receipt.getByText('Delivered in this session only', { exact: true }).count()).toBe(1)
    const snapshot = (await captureStableAria(page, '[data-schedule-reminder]', scaffold.workspaceCwd))
      .split(scheduleId).join('{{scheduleId}}')
      .replace(/\d{4}-\d{2}-\d{2}T(?:\d{2}:\d{2}:\d{2}\.\d{3}|\{\{clock\}\})Z/gu, '{{occurrenceAt}}')
    await compareOrRefreshGolden(RECEIPT_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['receipt.expected.md'])
  })
})
