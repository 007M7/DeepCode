// Keyless boot-chain smoke over the REAL carrier: startWebServer + web-plugins
// registry surface + __DSH_BOOT__ injection + built shell dist in a real
// chromium. First describe: manifest injection + static serving. Second
// describe: the settled success pass — seven REAL tsdown bundles (the
// infrastructure four + layout/sidebar/conversation) load through the DI
// chain in ?fixture mode and the three-column frame appears in one flip. The
// full conversation round lands in smoke-real under the W5 real-host standard.
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

/** id ↔ bundle table for the success pass (immediately four + layout/sidebar). */
const REAL_PLUGINS: { id: string; dir: string; inject: string[]; immediately?: boolean }[] = [
  { id: '@deepseek-ai/dsh-client-connection', dir: 'connection', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-runtime', dir: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-theme', dir: 'ui-theme', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-i18n', dir: 'i18n', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-layout', dir: 'ui-layout', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', dir: 'ui-sidebar', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-conversation', dir: 'ui-conversation', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
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
      host: '127.0.0.1',
      port,
      distIndex: DIST_INDEX,
      apiHandler,
      webPlugins: {
        snapshot: () => ROWS,
        clientPath: id => (id === ROWS[0]!.id ? LAYOUT_BUNDLE : undefined),
      },
    }, (err) => { pageErrors.push(`server: ${String(err)}`) })
    browser = await chromium.launch()
    page = await browser.newPage()
    page.on('pageerror', e => pageErrors.push(String(e)))
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

  it('applies the token sheets before any plugin CSS', async () => {
    const family = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-font-family'))
    expect(family.trim().length).toBeGreaterThan(0)
  })
})

describe('web boot chain success pass (keyless, seven real bundles, ?fixture)', () => {
  const missing = REAL_PLUGINS.filter(p => !existsSync(bundlePath(p.dir)))
  let server: Awaited<ReturnType<typeof startWebServer>>
  let browser: Browser
  let page: Page
  const pageErrors: string[] = []

  beforeAll(async () => {
    requireDist()
    if (missing.length > 0) throw new Error(`client bundles not built (pnpm --filter <pkg> bundle): ${missing.map(m => m.dir).join(', ')}`)
    const port = await probeFreePort()
    const rows: WebPluginBootEntry[] = REAL_PLUGINS.map((p) => {
      const row: WebPluginBootEntry = { id: p.id, url: `/plugins/${p.id}/client.js`, inject: p.inject }
      if (p.immediately === true) row.immediately = true
      return row
    })
    const byId = new Map(REAL_PLUGINS.map(p => [p.id, bundlePath(p.dir)]))
    // ?fixture never opens HTTP streams; /api is a tripwire like the first describe.
    const apiHandler = { fetch: () => Promise.resolve(new Response('fixture mode must not call /api', { status: 500 })) }
    server = await startWebServer({
      host: '127.0.0.1',
      port,
      distIndex: DIST_INDEX,
      apiHandler,
      webPlugins: { snapshot: () => rows, clientPath: id => byId.get(id) },
    }, (err) => { pageErrors.push(`server: ${String(err)}`) })
    browser = await chromium.launch()
    page = await browser.newPage()
    page.on('pageerror', e => pageErrors.push(String(e)))
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
    const template = await page.locator('[class*="frame"]').evaluate(el => getComputedStyle(el).gridTemplateColumns)
    expect(template.split(' ').length).toBe(3)
  })

  it('every plugin CSS landed with its ownership tag', async () => {
    const owners = await page.evaluate(() =>
      [...document.querySelectorAll('style[data-plugin]')].map(s => (s as HTMLElement).dataset['plugin']))
    expect(owners).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(owners).toContain('@deepseek-ai/dsh-client-ui-sidebar')
  })

  it('collapsed sidebar animates to a 56px rail with the four controls', async () => {
    onTestFailed(() => saveFailureShot(page, 'smoke-boot-collapsed-rail'))
    const frame = page.locator('[class*="frame"]')
    const firstTrack = async (): Promise<string> => (await frame.evaluate(
      el => getComputedStyle(el).gridTemplateColumns)).split(' ')[0]!
    // The tracks transition on the deepsuite curve; assert the animated
    // settle rather than an instant jump.
    const settledTrack = async (px: string): Promise<void> => {
      await expect.poll(firstTrack, { timeout: 2000 }).toBe(px)
    }
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    // Mid-collapse the wide chrome is still mounted, fading — not swapped out.
    expect(await page.locator('text=HARNESS').count()).toBe(1)
    await settledTrack('56px')
    await expect.poll(() => page.locator('text=HARNESS').count(), { timeout: 2000 }).toBe(0)
    for (const name of ['Expand sidebar', 'New session', 'New workspace', 'Search sessions', 'Settings']) {
      await expect(page.getByRole('button', { name }).isVisible(), name).resolves.toBe(true)
    }
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await settledTrack('300px')
    await expect(page.getByRole('button', { name: 'Collapse sidebar' }).isVisible()).resolves.toBe(true)
    // Rail search: collapse again, the search control expands and lands in the box.
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await settledTrack('56px')
    await page.getByRole('button', { name: 'Search sessions' }).click()
    await settledTrack('300px')
    const focused = await page.evaluate(() =>
      (document.activeElement as HTMLInputElement | null)?.placeholder ?? '')
    expect(focused).toContain('Search')
  })

  it('renders file tool rows and expands fixture reasoning from either click target', async () => {
    onTestFailed(() => saveFailureShot(page, 'smoke-think-disclosure'))
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"][aria-selected]').first().click()

    const thinkRoot = page.locator('[data-variant="think"]').first()
    const think = thinkRoot.getByRole('button')
    await think.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await think.getAttribute('aria-expanded')).toBe('false')

    await thinkRoot.getByText(/^思考过程 .*reasoning 内容。$/).click()
    expect(await think.getAttribute('aria-expanded')).toBe('true')
    expect(await thinkRoot.locator(':scope > div').count()).toBe(2)

    await think.getByText('Think', { exact: true }).click()
    expect(await think.getAttribute('aria-expanded')).toBe('false')

    const editRoot = page.locator('[data-variant="edit"]').first()
    await editRoot.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await editRoot.getByText('Edit', { exact: true }).count()).toBe(1)
    expect(await editRoot.getByText('notes/demo.txt', { exact: true }).count()).toBe(1)

    const writeRoot = page.locator('[data-variant="write"]').first()
    await writeRoot.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await writeRoot.getByText('Write', { exact: true }).count()).toBe(1)
    expect(await writeRoot.getByText('notes/new-demo.txt', { exact: true }).count()).toBe(1)
  })

  it('stayed clean: no page errors across the whole load chain', () => {
    expect(pageErrors).toEqual([])
  })
})
