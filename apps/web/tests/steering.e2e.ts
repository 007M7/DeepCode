// Web e2e scenario: queue a message while the first response streams, strictly
// transfer that exact occurrence to steering through QueueDock, then prove it
// is logged, rendered, and obeyed. The following question tool supplies a
// deterministic pending-steering snapshot before the step can drain.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/steering', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
// Two goldens for the two distinct states this interaction produces: the
// mid-turn moment (steer ACCEPTED but deliberately invisible — the loop
// drains steering at the step boundary, so no steering text exists while
// the question still blocks the step) and the settled transcript (plain
// bubble in place, final reply obeying it). The pair pins the timing
// semantics visually: if the client ever starts rendering pending steers
// eagerly, the mid-steer golden flips first.
const MID_EXPECTED = join(SNAPSHOT_DIR, 'mid-steer.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
const MODE = webSnapshotMode()

const PROMPT = 'Use the ask_user_question tool to ask me exactly one question with id "checkpoint", question "Ready to continue?", header "Checkpoint", and options labeled "Yes" and "No". After I answer, reply with one short sentence acknowledging my answer and stop.'
const STEER = 'Interjection: include the word BANANA in your final reply.'

/** Concatenated assistant text deltas — the model-visible reply body. */
function assistantText(events: SessionEvent[]): string {
  return events
    .filter(e => e.type === 'assistant/chunk')
    .map((e) => {
      const chunk = (e as SessionEvent & { data: { chunk: { type: string; text?: string } } }).data.chunk
      return chunk.type === 'text-delta' ? chunk.text ?? '' : ''
    })
    .join('')
}

describe('web e2e: mid-turn steering lands durably and visibly', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    // The slower replay keeps the Queue action available until the recorded question barrier arrives.
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 100 })
    scaffold.ctx.on('session/event', (_session, event) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Fresh world: connect a Workspace so the composer scenarios start live.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('strictly steers one queued row; the interjection is logged, rendered, and obeyed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-steering'))
    if (MODE !== 'record') {
      // The steer must NOT be a user/message — it lands as steering/message.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 180_000 : 30_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    // Enter remains the Queue gesture. The row action then atomically moves
    // this exact occurrence into the current turn's steering outbox.
    await input.fill(STEER)
    await input.press('Enter')
    const queued = page.getByText(STEER, { exact: true })
    await queued.waitFor({ timeout: 10_000 })
    const queuedRow = page.getByRole('listitem').filter({ hasText: STEER })
    const steerButton = queuedRow.getByRole('button', { name: 'Steer queued message' })
    await expect.poll(() => steerButton.isEnabled(), { timeout: 10_000 }).toBe(true)
    await steerButton.click({ timeout: 10_000 })
    await expect.poll(() => page.getByText(STEER, { exact: true }).count(), { timeout: 10_000 }).toBe(0)

    // The blocked composer is the mid-turn barrier: the tool cannot finish
    // this step, so the accepted steering remains pending and invisible.
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })

    if (MODE !== 'record') {
      // Mid-turn golden: the converted steer is pending in the loop but the
      // loop drains steering only at the step boundary, so no Queue row or
      // steering/message bubble renders while the question still blocks.
      expect(await page.getByText(STEER, { exact: true }).count()).toBe(0)
      expect(await page.getByRole('button', { name: 'Edit queued message' }).count()).toBe(0)
      const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(MID_EXPECTED, snapshot, MODE)
    }

    // Answer the composer; the tool result closes the step, the loop drains
    // the steer as steering/message, and the steered continuation runs the
    // final model call.
    await composer.getByRole('radio', { name: 'Yes' }).click()
    await composer.getByRole('radio', { name: 'Yes' }).press('Enter')
    await settled

    if (MODE === 'record') {
      const sessionId = await settled
      await recordFixture(scaffold, sessionId, FIXTURE)
      // Fixture honesty: a recording where the live model ignored the steer
      // would replay as a vacuous scenario — reject it and re-record instead.
      const recorded = parseSessionLog(await readFile(FIXTURE, 'utf8'))
      expect(recorded.filter(e => e.type === 'steering/message')).toHaveLength(1)
      expect(assistantText(recorded)).toContain('BANANA')
      return
    }

    // Durable: exactly one steering/message, inside turn 1, carrying the text.
    const steerEvents = sessionEvents.filter(e => e.type === 'steering/message')
    expect(steerEvents).toHaveLength(1)
    expect((steerEvents[0] as SessionEvent & { data: { turn: number } }).data.turn).toBe(1)
    expect(JSON.stringify(steerEvents[0])).toContain('BANANA')
    const turnEnds = sessionEvents.filter(e => e.type === 'turn/end')
    expect(turnEnds).toHaveLength(1)
    expect((turnEnds[0] as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind).toBe('completed')

    // Visible: the plain steering bubble plus the reply that obeys it
    // (steer text + final reply each contain the marker word).
    await expect.poll(() => page.getByText(STEER, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => page.getByText('BANANA', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    expect(await page.locator('[data-question-key]').count()).toBe(0)
    // Settled golden: steer text between the question round trip and the
    // obeying reply, composer takeover gone.
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'mid-steer.expected.md', 'settled.expected.md'])
  })
})
