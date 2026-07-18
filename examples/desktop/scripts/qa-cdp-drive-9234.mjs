#!/usr/bin/env node
// CDP driver for the bench lane — port 9234. Same shape as
// scripts/qa-cdp-drive-9223.mjs but pinned to a different port so multiple
// lanes' Electron instances can coexist.
//
// Usage:
//   node scripts/qa-cdp-drive-9234.mjs js '<expression>'
//   node scripts/qa-cdp-drive-9234.mjs switchTab bench
//   node scripts/qa-cdp-drive-9234.mjs shot <path>

import http from 'node:http'
import fs from 'node:fs'

const PORT = 9234

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json/list`, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function pickPage() {
  const t = await listTargets()
  const p = t.find(x => x.title === 'DSH Desktop') || t.find(x => x.type === 'page')
  if (!p) throw new Error('no DSH page')
  return p.webSocketDebuggerUrl
}

async function connect() {
  const url = await pickPage()
  const ws = new WebSocket(url)
  await new Promise((r, j) => { ws.onopen = () => r(); ws.onerror = (e) => j(e.message) })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
  function send(method, params) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  return { send, ws }
}

async function evalExpr(client, expr) {
  const r = await client.send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails))
  return r.result && r.result.value
}

async function main() {
  const [, , cmd, ...rest] = process.argv
  const client = await connect()
  try {
    if (cmd === 'js') {
      const val = await evalExpr(client, rest.join(' '))
      console.log(JSON.stringify(val, null, 2))
    } else if (cmd === 'switchTab') {
      await evalExpr(client, `window.__dshTabs.switchTo(${JSON.stringify(rest[0])}); true`)
      console.log('OK')
    } else if (cmd === 'shot') {
      const outPath = rest[0]
      await client.send('Page.enable')
      // Bring window forward before capture (macOS Electron sometimes hides on
      // background). window.reveal seam.
      try { await evalExpr(client, 'window.dsh && window.dsh.qa && window.dsh.qa.reveal && window.dsh.qa.reveal()') } catch {}
      const r = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'))
      console.log('wrote', outPath, fs.statSync(outPath).size, 'bytes')
    } else if (cmd === 'wait') {
      await new Promise(r => setTimeout(r, Number(rest[0] || 500)))
      console.log('ok')
    } else {
      console.log('usage: js <expr> | switchTab <name> | shot <path> | wait <ms>')
    }
  } finally {
    client.ws.close()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
