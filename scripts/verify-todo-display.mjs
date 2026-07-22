// Manual acceptance probe: boot the real shell + 8 bundles in ?fixture mode,
// open fx-alpha, assert the TodoPanel strip and the todo_write row render.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { startWebServer } from '@deepseek-ai/dsh-host-webserver'

// playwright is a dependency of apps/web (the browser test owner), not the root.
const { chromium } = createRequire(new URL('../apps/web/package.json', import.meta.url)).call(undefined, 'playwright')

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = (dir) => `${root}packages/client/${dir}/lib/client.js`
const PLUGINS = [
  { id: '@deepseek-ai/dsh-client-connection', dir: 'connection', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-runtime', dir: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-theme', dir: 'ui-theme', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-i18n', dir: 'i18n', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-layout', dir: 'ui-layout', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', dir: 'ui-sidebar', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-conversation', dir: 'ui-conversation', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-trajectory', dir: 'ui-trajectory', inject: ['@deepseek-ai/dsh-client-ui-conversation'] },
]
for (const p of PLUGINS) if (!existsSync(bundle(p.dir))) throw new Error(`bundle missing: ${p.dir}`)

const rows = PLUGINS.map(p => ({
  id: p.id, url: `/plugins/${p.id}/client.js?rev=verify`, rev: 'verify',
  ...(p.inject.length > 0 ? { inject: p.inject } : {}),
  ...(p.immediately ? { immediately: true } : {}),
}))
const graph = { rev: 'verify', entries: rows }
const byId = new Map(PLUGINS.map(p => [p.id, bundle(p.dir)]))
const port = 34567
const errors = []
const server = await startWebServer({
  host: '127.0.0.1',
  port,
  distIndex: `${root}apps/web/dist/index.html`,
  apiHandler: { fetch: () => Promise.resolve(new Response('fixture mode must not call /api', { status: 500 })) },
  webPlugins: { graph: () => graph, clientPath: (id) => byId.get(id), onRebuilt: () => () => undefined },
}, (err) => errors.push(`server: ${String(err)}`))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
page.on('pageerror', e => errors.push(String(e)))
await page.goto(`http://127.0.0.1:${port}/?fixture`, { waitUntil: 'load' })
try {
  await page.waitForSelector('[class*="frame"]', { timeout: 15000 })
} catch (e) {
  console.error('BODY:', (await page.evaluate(() => document.body.innerText)).slice(0, 400))
  console.error('STATUS:', await page.evaluate(() => JSON.stringify(globalThis

.__DSH_LOADER_STATUS__ ?? 'n/a')))
  console.error('BOOT:', await page.evaluate(() => JSON.stringify(window.__DSH_BOOT__)))
  const reqs = await page.evaluate(() => performance.getEntriesByType('resource').map(r => `${r.name.split('/').slice(-2).join('/')}=${r.responseStatus ?? '?'}`))
  console.error('RES:', reqs.join(' '))
  console.error('ERRORS:', errors.join(' ;; '))
  throw e
}

// Open fx-alpha: expand the workspace group, then click the newest session row.
await page.locator('[role="treeitem"]').first().click()
// fx-alpha is the newest (running) session — the first option row.
const sessionRow = page.locator('[role="treeitem"][aria-selected]').first()
await sessionRow.waitFor({ timeout: 5000 })
await sessionRow.click()
await page.waitForSelector('[data-testid="todo-panel"]', { timeout: 15000 })
console.log('✓ TodoPanel visible')

const panelText = await page.locator('[data-testid="todo-panel"]').innerText()
for (const expected of ['Plan', '1/3', '梳理需求', '实现 fixture 样本', '浏览器验收']) {
  if (!panelText.includes(expected)) throw new Error(`TodoPanel missing "${expected}"; got: ${panelText}`)
}
console.log('✓ TodoPanel content: counts + all three items')

await page.screenshot({ path: `${root}.artifacts/todo-01-panel.png` })

// The todo_write row in the flow (turn 63 sample, already at the bottom).
const row = page.locator('[data-sample="todo-row"]')
await row.waitFor({ timeout: 10000 })
const rowText = await row.innerText()
if (!rowText.includes('更新任务清单') || !rowText.includes('1/3 已完成')) throw new Error(`TodoRow wrong: ${rowText}`)
console.log('✓ TodoRow renders plan summary:', rowText.replace(/\n/g, ' '))
await page.screenshot({ path: `${root}.artifacts/todo-02-row.png` })

// Row click opens details with the raw args.
await row.click()
await page.waitForSelector('text=Input', { timeout: 5000 })
console.log('✓ TodoRow click opens details')
await page.screenshot({ path: `${root}.artifacts/todo-03-details.png` })

// Collapse: list hides, active item hint appears in the header.
await page.locator('[data-testid="todo-panel"] button').first().click()
const collapsed = await page.locator('[data-testid="todo-panel"]').innerText()
if (collapsed.includes('梳理需求')) throw new Error('collapse failed: list still visible')
if (!collapsed.includes('实现 fixture 样本')) throw new Error('collapsed hint missing the active item')
console.log('✓ Collapse hides list, shows active hint')
await page.screenshot({ path: `${root}.artifacts/todo-04-collapsed.png` })

// Dark theme spot check.
await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
await page.screenshot({ path: `${root}.artifacts/todo-05-dark.png` })
console.log('✓ Dark screenshot taken')

if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`)
console.log('✓ No page errors — todo display acceptance PASSED')
await browser.close()
await server.close()
