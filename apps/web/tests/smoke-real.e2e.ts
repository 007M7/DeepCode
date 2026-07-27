// W5 real-host smoke: spawn `dsh web` with a real key, walk the full W5 flow
// list in a real chromium, screenshot every screen into .artifacts/ for the
// figma comparison pass. Self-skips without DEEPSEEK_API_KEY (repo e2e
// convention); the runner loads the repo-root .env explicitly because the CLI
// only auto-loads .env from its cwd (a temp dir here, so sessions never land
// in the repo's .sessions).
//
// Selector convention: CSS Modules hash as [hash]_[local], so class-substring
// selectors are unreliable — anchor on data-* attributes (data-variant /
// data-clickable / data-sample) or visible text. The one [class*=] use below
// (frame/handle) rides local names that survive hashing as suffixes; prefer
// data-* for anything new.
//
// Flow order matters: chat rounds first (5 depends on 3's session), geometry
// and theme after, reload recovery last. Tests run sequentially in-file.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { REPO_ROOT, connectFreshWorkspace, probeFreePort, requireDist, saveFailureShot } from './support.ts'

/** Repo-root .env → process.env (never overrides an already-set variable). */
function loadRootEnv(): void {
  const envPath = join(REPO_ROOT, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (m !== null && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]
  }
}
loadRootEnv()

function waitForReadyLine(child: ChildProcess): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let out = ''
    const timer = setTimeout(() => { reject(new Error(`dsh web not ready in 90s; output:\n${out}`)) }, 90_000)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(out)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited early (code ${code}); output:\n${out}`))
    })
  })
}

async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `smoke-${method}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

interface HistoryPage {
  events: { event: { type: string; data: unknown } }[]
  hasMore: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function providerTitle(page: HistoryPage): string | undefined {
  for (let index = page.events.length - 1; index >= 0; index--) {
    const event = page.events[index]!.event
    if (event.type !== 'session/title' || !isRecord(event.data)) continue
    const source = event.data.source
    if (typeof event.data.title === 'string' && isRecord(source) && source.kind === 'provider') {
      return event.data.title
    }
  }
  return undefined
}

function hasAssistantMarker(page: HistoryPage, marker: string): boolean {
  return page.events.some(({ event }) => {
    if (event.type !== 'assistant/message' || !isRecord(event.data) || !Array.isArray(event.data.content)) return false
    return event.data.content.some(block =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.includes(marker))
  })
}

async function history(baseUrl: string, sessionId: string): Promise<HistoryPage> {
  return rpc<HistoryPage>(baseUrl, 'session.history', { sessionId, maxMessages: 10 })
}

async function waitForProviderTitle(baseUrl: string, sessionId: string): Promise<string> {
  let observed: string | undefined
  await expect.poll(async () => {
    observed = providerTitle(await history(baseUrl, sessionId))
    return observed
  }, { timeout: 90_000 }).toEqual(expect.any(String))
  if (observed === undefined) throw new Error('provider-backed session title was not observed')
  return observed
}

async function waitForAssistantMarker(baseUrl: string, sessionId: string, marker: string): Promise<void> {
  await expect.poll(async () => hasAssistantMarker(await history(baseUrl, sessionId), marker), {
    timeout: 120_000,
  }).toBe(true)
}

/** W5 screenshot: evidence for the figma comparison, not a failure artifact. */
async function screen(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts', `w5-${name}.png`) })
}

/** First column track (px string) of the frame grid. */
async function firstTrack(page: Page): Promise<string> {
  return (await page.locator('[class*="frame"]').evaluate(
    el => getComputedStyle(el).gridTemplateColumns)).split(' ')[0]!
}

/** Last column track (details) as a number of pixels. */
async function detailsTrack(page: Page): Promise<number> {
  const cols = await page.locator('[class*="frame"]').evaluate(
    el => getComputedStyle(el).gridTemplateColumns)
  return Number(cols.split(' ').pop()!.replace('px', ''))
}

// Readiness gate: `dsh web` serves ALL nine manifest plugins; until every UI
// plugin's client bundle exists and exports apply, the loader fail-louds and
// the frame never appears.
const UI_PLUGIN_DIRS = ['connection', 'runtime', 'ui-theme', 'locale', 'ui-layout', 'ui-sidebar', 'ui-settings', 'ui-settings-general', 'ui-models', 'ui-conversation', 'ui-question', 'ui-trajectory']
const ROUND_DONE_MARKER = 'WEB_ROUND_DONE'
const notReady = UI_PLUGIN_DIRS.filter((dir) => {
  const bundle = join(REPO_ROOT, 'packages/client', dir, 'lib/client.js')
  return !existsSync(bundle) || !readFileSync(bundle, 'utf8').includes('exports.apply')
})
if (notReady.length > 0) console.warn(`[smoke-real] skipped — client bundles not ready: ${notReady.join(', ')}`)

describe('dsh web keyless CLI smoke', () => {
  it('listens on 127.0.0.1 by default', async () => {
    requireDist()
    const sessionsDir = mkdtempSync(join(tmpdir(), 'dsh-web-keyless-'))
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--port', '0'],
      {
        cwd: sessionsDir,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-no-call',
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const readyUrl = await waitForReadyLine(child)
      expect(readyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect((await fetch(readyUrl)).status).toBe(200)
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('injects the invoking workspace AGENTS.md into the provider request', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-web-workspace-'))
    mkdirSync(join(workspace, '.git'))
    writeFileSync(join(workspace, 'AGENTS.md'), 'web-workspace-context-probe\n')

    let resolveProviderRequest!: (request: { messages?: { role?: string; content?: string }[] }) => void
    const providerRequest = new Promise<{ messages?: { role?: string; content?: string }[] }>((resolve) => {
      resolveProviderRequest = resolve
    })
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        resolveProviderRequest(JSON.parse(body) as { messages?: { role?: string; content?: string }[] })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
          'data: {"choices":[{"delta":{"content":"done"}}]}',
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-workspace',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          DSH_HOME: join(workspace, '.dsh'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await rpc<{ sessionId: string }>(baseUrl, 'session.create', {})
      await rpc<{ accepted: true }>(baseUrl, 'session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'go' }],
      })
      const captured = await Promise.race([
        providerRequest,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('provider request not received in 10s')) }, 10_000).unref()
        }),
      ])
      const workspaceMessage = captured.messages?.find(message =>
        message.role === 'user' && message.content?.includes('web-workspace-context-probe'))
      expect(workspaceMessage).toMatchInlineSnapshot(`
        {
          "content": "<system-reminder>
        The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

        Instructions from: AGENTS.md

        web-workspace-context-probe

        </system-reminder>",
          "role": "user",
        }
      `)
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('DSH_TOOLS_MODE=code collapses the provider wire tools to run_code with the SDK prompt section', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-web-code-mode-'))

    interface CodeModeProviderRequest {
      messages?: { role?: string; content?: string }[]
      tools?: { function?: { name?: string } }[]
    }
    let resolveProviderRequest!: (request: CodeModeProviderRequest) => void
    const providerRequest = new Promise<CodeModeProviderRequest>((resolve) => {
      resolveProviderRequest = resolve
    })
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        resolveProviderRequest(JSON.parse(body) as CodeModeProviderRequest)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
          'data: {"choices":[{"delta":{"content":"done"}}]}',
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-code-mode',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          DSH_TOOLS_MODE: 'code',
          DSH_HOME: join(workspace, '.dsh'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await rpc<{ sessionId: string }>(baseUrl, 'session.create', {})
      await rpc<{ accepted: true }>(baseUrl, 'session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'go' }],
      })
      const captured = await Promise.race([
        providerRequest,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('provider request not received in 10s')) }, 10_000).unref()
        }),
      ])
      expect(captured.tools?.map(tool => tool.function?.name)).toEqual(['run_code'])
      const system = captured.messages?.find(message => message.role === 'system')
      expect(system?.content).toContain('## Writing code for run_code')
      expect(system?.content).toContain('declare const tools')
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY || notReady.length > 0)('web smoke (real host, real key, W5)', () => {
  let child: ChildProcess
  let sessionsDir: string
  let baseUrl: string
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []

  beforeAll(async () => {
    requireDist()
    sessionsDir = mkdtempSync(join(tmpdir(), 'dsh-web-w5-'))
    const port = await probeFreePort()
    // tsx boot mirrors demo:web — lib/ may be unbuilt in this worktree. cwd is a
    // temp dir (persistenceRoot is cwd-relative), so tsx needs the repo's loader
    // and tsconfig paths pointed at explicitly.
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--port', String(port)],
      {
        cwd: sessionsDir,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    baseUrl = (await waitForReadyLine(child)).replace('0.0.0.0', '127.0.0.1')
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page.goto(baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    if (child !== undefined && child.exitCode === null) {
      const gone = new Promise<void>(resolveExit => child.once('exit', () => { resolveExit() }))
      child.kill('SIGTERM')
      await Promise.race([gone, new Promise(r => setTimeout(r, 10_000).unref())])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    if (sessionsDir !== undefined) rmSync(sessionsDir, { recursive: true, force: true })
  })

  it('1 cold start: loading page settles into the three-column frame', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-cold-start'))
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(await page.locator('text=Failed to load plugins').count()).toBe(0)
    const template = await page.locator('[class*="frame"]').evaluate(el => getComputedStyle(el).gridTemplateColumns)
    expect(template.split(' ').length).toBe(3)
    await screen(page, '01-cold-start')
  })

  it('2+3 empty-state first send completes a real model round', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-first-round'))
    // Fresh world: connect a Workspace so the composer starts live.
    await connectFreshWorkspace(page)
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    await screen(page, '02-empty-state')
    const prompt = `Please answer this request carefully: explain event sourcing in two sentences, ending with exactly ${ROUND_DONE_MARKER}.`
    await input.fill(prompt)
    await input.press('Enter')
    // The first send must keep the session tree mounted; a near-empty body
    // reveals a duplicate runtime bundle with incompatible scope tags.
    await page.waitForFunction(() => document.body.innerText.length > 50, undefined, { timeout: 15_000 })
    expect(pageErrors).toEqual([])
    await page.waitForFunction(
      () => document.title !== 'DeepSeek Harness' && document.title.endsWith(' — DeepSeek Harness'),
      undefined,
      { timeout: 15_000 },
    )
    await expect.poll(async () => (await rpc<{ items: { sessionId: string }[] }>(baseUrl, 'session.list', {})).items.length, {
      timeout: 15_000,
    }).toBe(1)
    const sessions = await rpc<{ items: { sessionId: string }[] }>(baseUrl, 'session.list', {})
    const sessionId = sessions.items[0]?.sessionId
    if (sessionId === undefined) throw new Error('created Web session was not listed')
    const durableTitle = await waitForProviderTitle(baseUrl, sessionId)
    await page.waitForFunction(
      expected => document.title === `${expected} — DeepSeek Harness`,
      durableTitle,
      { timeout: 15_000 },
    )
    const sessionTree = page.getByRole('tree', { name: 'Sessions' })
    const projectRow = sessionTree.getByRole('treeitem').first()
    if (await projectRow.getAttribute('aria-expanded') === 'false') await projectRow.click()
    await Promise.all([
      sessionTree.getByText(durableTitle, { exact: true }).waitFor({ timeout: 10_000 }),
      page.getByRole('navigation').getByText(durableTitle, { exact: true }).waitFor({ timeout: 10_000 }),
    ])
    await waitForAssistantMarker(baseUrl, sessionId, ROUND_DONE_MARKER)
    await page.locator('p').filter({ hasText: ROUND_DONE_MARKER }).waitFor({ timeout: 10_000 })
    await screen(page, '04-round-complete')
  }, 150_000)

  it('4 view tabs: Chat / Trajectory / Waterfall all switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-tabs'))
    await page.locator('button', { hasText: /Trajectory/i }).first().click()
    await screen(page, '05-trajectory-tab')
    await page.locator('button', { hasText: /Waterfall/i }).first().click()
    await screen(page, '06-waterfall-tab')
    await page.locator('button', { hasText: /^Chat$/i }).first().click()
    await screen(page, '07-back-to-chat')
  })

  it('5 bash differential rendering: tool row click opens the details column', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-tool-details'))
    const input = page.locator('textarea').first()
    await input.fill('请用 bash 工具运行命令 echo w5marker 然后告诉我结果')
    await input.press('Enter')
    // Wait for the tool ROW, not response text (the reply echoes any marker).
    // Bash renders through the third-party sample registration. Match that
    // exact row: other clickable variants (for example Think disclosure)
    // may precede the tool call in document order.
    const toolRow = page.locator('[data-sample="bash-global"]')
    await toolRow.waitFor({ timeout: 120_000 })
    await screen(page, '08-bash-round')
    expect(await detailsTrack(page)).toBe(0)
    await toolRow.click()
    // Selection channel: click writes selection + layout.openDetails.
    await page.waitForFunction(() => {
      const frame = document.querySelector('[class*="frame"]')
      if (frame === null) return false
      return Number(getComputedStyle(frame).gridTemplateColumns.split(' ').pop()!.replace('px', '')) > 0
    }, undefined, { timeout: 10_000 })
    await screen(page, '09-details-open')
  }, 150_000)

  it('6 sidebar drag widens the column and persists across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-drag'))
    const before = await firstTrack(page)
    const handle = page.locator('[class*="handle"]').first()
    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 300)
    await page.mouse.down()
    await page.mouse.move(box!.x + 70, box!.y + 300, { steps: 6 })
    await page.mouse.up()
    const after = await firstTrack(page)
    expect(after).not.toBe(before)
    await screen(page, '10-sidebar-dragged')
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(await firstTrack(page)).toBe(after)
  })

  it('7 dark mode: the body attribute cascades the token sheets', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-dark'))
    // theme.apply === toggling this attribute (v3 §8); no switcher UI owns it
    // in P-I, so the acceptance drives the documented mechanism directly.
    const dark = await page.evaluate(() => {
      document.body.setAttribute('data-ds-dark-theme', '')
      return getComputedStyle(document.body).backgroundColor
    })
    await screen(page, '11-dark-mode')
    const light = await page.evaluate(() => {
      document.body.removeAttribute('data-ds-dark-theme')
      return getComputedStyle(document.body).backgroundColor
    })
    expect(dark).not.toBe(light)
  })

  it('8 reload recovery: history replays after a fresh boot', async () => {
    onTestFailed(() => saveFailureShot(page, 'w5-reload'))
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('p').filter({ hasText: ROUND_DONE_MARKER }).waitFor({ timeout: 30_000 })
    await screen(page, '12-reload-recovery')
  })

  it('stayed clean: no page errors across every flow', () => {
    expect(pageErrors).toEqual([])
  })
})
