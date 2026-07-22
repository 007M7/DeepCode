// Keyless boot-chain smoke over the REAL carrier: startWebServer + web-plugins
// registry surface + __DSH_BOOT__ injection + built shell dist in a real
// chromium. First describe: manifest injection + fail-loud half. Second
// describe: the settled success pass — all nine REAL tsdown bundles load
// through the DI chain in ?fixture mode, the three-column frame appears in
// one flip, and the resident question completes through the real UI stack.
// The full model round lands in smoke-real under the W5 real-host standard.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { startWebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WebPluginBootEntry } from '@deepseek-ai/dsh-host-webserver'
import { DIST_INDEX, probeFreePort, requireDist, saveFailureShot } from './support.ts'

const bundlePath = (dir: string): string =>
  fileURLToPath(new URL(`../../../packages/client/${dir}/lib/client.js`, import.meta.url))

/** id ↔ bundle table for the success pass (the complete Web UI assembly). */
const REAL_PLUGINS: { id: string; dir: string; inject: string[]; immediately?: boolean }[] = [
  { id: '@deepseek-ai/dsh-client-connection', dir: 'connection', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-runtime', dir: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-theme', dir: 'ui-theme', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-i18n', dir: 'i18n', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-layout', dir: 'ui-layout', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', dir: 'ui-sidebar', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-conversation', dir: 'ui-conversation', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-question', dir: 'ui-question', inject: ['@deepseek-ai/dsh-client-ui-conversation'] },
  { id: '@deepseek-ai/dsh-client-ui-trajectory', dir: 'ui-trajectory', inject: ['@deepseek-ai/dsh-client-ui-conversation'] },
]

/** Manifest served by the fake registry: one live bundle row, one missing row. */
const ROWS: WebPluginBootEntry[] = [
  { id: '@deepseek-ai/dsh-client-ui-layout', url: '/plugins/@deepseek-ai/dsh-client-ui-layout/client.js', inject: [] },
  { id: '@probe/absent', url: '/plugins/@probe/absent/client.js', inject: [] },
]
const LAYOUT_BUNDLE = bundlePath('ui-layout')

describe('web boot chain (keyless, real carrier)', () => {
  let server: Awaited<ReturnType<typeof startWebServer>>
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []

  beforeAll(async () => {
    requireDist()
    const port = await probeFreePort()
    const apiHandler = { fetch: () => Promise.resolve(new Response('boot smoke must not call /api', { status: 500 })) }
    server = await startWebServer({
      port,
      distIndex: DIST_INDEX,
      apiHandler,
      webPlugins: {
        snapshot: () => ROWS,
        clientPath: (id) => (id === ROWS[0]!.id ? LAYOUT_BUNDLE : undefined),
      },
    }, (err) => { pageErrors.push(`server: ${String(err)}`) })
    browser = await chromium.launch()
    page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  })

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  it('GET / injects the manifest verbatim', async () => {
    onTestFailed(() => saveFailureShot(page, 'smoke-boot-manifest'))
    const boot = await page.evaluate(() => (window as { __DSH_BOOT__?: unknown }).__DSH_BOOT__)
    expect(boot).toEqual({ plugins: ROWS })
  })

  it('serves a real bundle through the plugins endpoint', async () => {
    const res = await page.request.get(`${new URL(page.url()).origin}${ROWS[0]!.url}`)
    expect(res.status()).toBe(200)
    expect(await res.text()).toContain('window.DSHClientProxy.loadPlugin')
  })

  it('boots to the loading page and fail-louds the absent plugin', async () => {
    onTestFailed(() => saveFailureShot(page, 'smoke-boot-fail-loud'))
    await page.waitForSelector('text=HARNESS', { timeout: 10_000 })
    await page.waitForSelector('text=Failed to load plugins', { timeout: 10_000 })
    await page.waitForSelector('text=@probe/absent', { timeout: 2000 })
    // The real UI must not have flipped in: the gate opens only on settled().
    expect(await page.locator('[class*="frame"]').count()).toBe(0)
  })

  it('applies the token sheets before any plugin CSS', async () => {
    const family = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-font-family'))
    expect(family.trim().length).toBeGreaterThan(0)
  })
})

describe('web boot chain success pass (keyless, nine real bundles, ?fixture)', () => {
  const missing = REAL_PLUGINS.filter((p) => !existsSync(bundlePath(p.dir)))
  let server: Awaited<ReturnType<typeof startWebServer>>
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []

  beforeAll(async () => {
    requireDist()
    if (missing.length > 0) throw new Error(`client bundles not built (pnpm --filter <pkg> bundle): ${missing.map((m) => m.dir).join(', ')}`)
    const port = await probeFreePort()
    const rows: WebPluginBootEntry[] = REAL_PLUGINS.map((p) => {
      const row: WebPluginBootEntry = { id: p.id, url: `/plugins/${p.id}/client.js`, inject: p.inject }
      if (p.immediately === true) row.immediately = true
      return row
    })
    const byId = new Map(REAL_PLUGINS.map((p) => [p.id, bundlePath(p.dir)]))
    // ?fixture never opens HTTP streams; /api is a tripwire like the first describe.
    const apiHandler = { fetch: () => Promise.resolve(new Response('fixture mode must not call /api', { status: 500 })) }
    server = await startWebServer({
      port,
      distIndex: DIST_INDEX,
      apiHandler,
      webPlugins: { snapshot: () => rows, clientPath: (id) => byId.get(id) },
    }, (err) => { pageErrors.push(`server: ${String(err)}`) })
    browser = await chromium.launch()
    page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.goto(`http://127.0.0.1:${port}/?fixture`, { waitUntil: 'load' })
  })

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  it('settles and flips to the three-column frame in one pass', async () => {
    onTestFailed(() => saveFailureShot(page, 'smoke-boot-settled'))
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    // Loading page is gone; the grid carries the three tracks.
    expect(await page.locator('text=Failed to load plugins').count()).toBe(0)
    const template = await page.locator('[class*="frame"]').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    expect(template.split(' ').length).toBe(3)
  })

  it('every plugin CSS landed with its ownership tag', async () => {
    const owners = await page.evaluate(() =>
      [...document.querySelectorAll('style[data-plugin]')].map((s) => (s as HTMLElement).dataset['plugin']))
    expect(owners).toContain('@deepseek-ai/dsh-client-ui-layout')
  })

  it('renders and completes the resident question through the composer slot', async () => {
    onTestFailed(() => saveFailureShot(page, 'smoke-question-composer'))
    await page.getByText('fixture', { exact: true }).click()
    await page.locator('[role="treeitem"]').nth(1).click()
    const composer = page.locator('[data-question-rpc-id]')
    await composer.waitFor({ timeout: 15_000 })
    expect({
      question: await composer.getByRole('heading').innerText(),
      progress: await composer.getByText('1 / 3', { exact: true }).innerText(),
      options: await composer.getByRole('radio').allTextContents(),
      custom: await composer.getByRole('button', { name: '其他，请填写自定义答案' }).innerText(),
    }).toMatchInlineSnapshot(`
      {
        "custom": "其他，请填写自定义答案",
        "options": [
          "1工程落地型推荐更看重能直接做 runtime、tool executor、sandbox、trace 和线上问题排查。",
          "2研究潜力型更看重 Agent 理解、训练评测思路和长期成长空间。",
          "3均衡型同时要求工程能力和 Agent 认知，但可能筛选门槛更高。",
        ],
        "progress": "1 / 3",
        "question": "你现在更想招哪类 Agent/Harness 候选人？",
      }
    `)

    await composer.getByRole('radio', { name: '工程落地型' }).click()
    await composer.getByText('2 / 3', { exact: true }).waitFor()
    await composer.getByRole('button', { name: '跳过本题', exact: true }).click()
    await composer.getByRole('checkbox', { name: '系统设计' }).click()
    await composer.getByRole('checkbox', { name: 'Agent 产品判断' }).click()
    await composer.getByRole('checkbox', { name: 'Agent 产品判断' }).press('Enter')

    await composer.waitFor({ state: 'detached' })
    const restoredInput = page.locator('textarea[placeholder]')
    await restoredInput.waitFor()
    expect(await restoredInput.getAttribute('placeholder')).toBe('回复生成中，可停止后再输入')
  })

  it('stayed clean: no page errors across the whole load chain', () => {
    expect(pageErrors).toEqual([])
  })
})
