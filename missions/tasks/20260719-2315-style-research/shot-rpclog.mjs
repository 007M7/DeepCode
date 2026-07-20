// RpcLog 面板截图（改造前后对比用）。跑法：node shot-rpclog.mjs <输出png>
import { chromium } from 'playwright'

const out = process.argv[2] ?? 'rpclog.png'
const BASE = process.env.DSC_WEB_URL ?? 'http://127.0.0.1:3080'

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(`${BASE}/?fixture`, { waitUntil: 'load' })
  // step-session 换壳后（SessionsScreen 两列）以侧栏为壳存在断言
  await page.waitForSelector('aside')
  const badge = page.locator('button', { hasText: 'RPC' }).first()
  await badge.waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  await badge.click()
  await page.locator('div[class*="list"]').first().waitFor({ state: 'visible' })
  // 造几行 + 展开一行 payload，让截图信息量足
  for (let i = 0; i < 3; i += 1) {
    await page.locator('button', { hasText: 'ping' }).click()
    await page.waitForTimeout(80)
  }
  await page.locator('button[class*="rowLine"]').first().click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: out })
  console.log(`saved ${out}`)
} finally {
  await browser.close()
}
