#!/usr/bin/env node
// CDP driver for the test-real lane, pinned to port 9223.
//
// This file is a sibling of scripts/qa-cdp-drive.mjs. The split is a
// concurrency accommodation, not a design goal:
//
//   9222 — qa-walkthrough lane's Electron (surface walk-throughs)
//   9223 — test-real lane's Electron (real-API and CDP-click passes)
//   9224 — qa-functional lane's Electron
//
// Running several Electron instances on the same debug port would race, so
// each lane owns a port and its own driver flavour. Everything else about
// the two drivers is compatible; use qa-cdp-drive.mjs if you're touching
// the 9222 instance, this one if you're on 9223.
//
// Prereqs: launch Electron with --remote-debugging-port=9223. Uses Node's
// built-in WebSocket (no Origin header) so Chromium doesn't 403 the connect
// the way a browser-origin WS would.
//
// Usage:
//   node scripts/qa-cdp-drive-9223.mjs state
//   node scripts/qa-cdp-drive-9223.mjs js '<expression>'
//   node scripts/qa-cdp-drive-9223.mjs switch <profile>
//   node scripts/qa-cdp-drive-9223.mjs newSession
//   node scripts/qa-cdp-drive-9223.mjs send '<prompt>'
//   node scripts/qa-cdp-drive-9223.mjs wait <ms>
//   node scripts/qa-cdp-drive-9223.mjs shot <path>
//   node scripts/qa-cdp-drive-9223.mjs stream
//   node scripts/qa-cdp-drive-9223.mjs switchTab <tab>   # chat|tree|mission|growth|plugins|prs
//   node scripts/qa-cdp-drive-9223.mjs sessions
//   node scripts/qa-cdp-drive-9223.mjs select <sessionId>
//
// Everything runs through Runtime.evaluate awaitPromise:true; expressions
// that need await should be wrapped as an IIFE, e.g.:
//   js '(async()=>({s:await window.dsh.listSessions()}))()'

import http from 'node:http'
import fs from 'node:fs'

const PORT = process.env.CDP_PORT ? Number(process.env.CDP_PORT) : 9223

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json/list`, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function pickPage() {
  const t = await listTargets()
  const p = t.find((x) => x.title === 'DSH Desktop') || t.find((x) => x.type === 'page')
  if (!p) throw new Error('no DSH page in ' + JSON.stringify(t.map(x => x.title)))
  return p.webSocketDebuggerUrl
}

async function connect() {
  const url = await pickPage()
  const ws = new WebSocket(url)
  await new Promise((r, j) => { ws.onopen = () => r(); ws.onerror = (e) => j(e.message || 'ws err') })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
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
  async function evalExpr(expr, awaitProm = true) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: awaitProm,
      timeout: 60000,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''))
    return r.result && r.result.value
  }
  async function screenshot(path) {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  }
  return { ws, evalExpr, screenshot, close: () => ws.close() }
}

async function main() {
  const [, , cmd, ...args] = process.argv
  const c = await connect()
  try {
    switch (cmd) {
      case 'state': {
        const s = await c.evalExpr('JSON.stringify(window.__dshRenderer && window.__dshRenderer.snapshotState && window.__dshRenderer.snapshotState() || {noSeam:true})')
        console.log(s)
        break
      }
      case 'stream': {
        const t = await c.evalExpr('window.__dshRenderer && window.__dshRenderer.getStreamText && window.__dshRenderer.getStreamText()')
        console.log(t)
        break
      }
      case 'streamHtml': {
        const t = await c.evalExpr('document.getElementById("stream") && document.getElementById("stream").innerHTML')
        console.log(t)
        break
      }
      case 'js': {
        const expr = args.join(' ')
        const v = await c.evalExpr(expr)
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
        break
      }
      case 'switch': {
        const p = args[0]
        const v = await c.evalExpr(`(async()=>{ await window.dsh.startRuntime(${JSON.stringify(p)}); return await window.dsh.runtimeStatus() })()`)
        console.log(JSON.stringify(v, null, 2))
        break
      }
      case 'newSession': {
        const v = await c.evalExpr('(async()=>await window.dsh.newSession())()')
        console.log(JSON.stringify(v, null, 2))
        break
      }
      case 'send': {
        const text = args.join(' ')
        const v = await c.evalExpr(`(async()=>{ const sid = window.__dshRenderer && window.__dshRenderer.getActiveSessionId && window.__dshRenderer.getActiveSessionId(); if (!sid) return {noSession:true}; return await window.dsh.sendPrompt(sid, ${JSON.stringify(text)}) })()`)
        console.log(JSON.stringify(v, null, 2))
        break
      }
      case 'wait': {
        await new Promise((r) => setTimeout(r, Number(args[0]) || 1000))
        console.log('waited', args[0])
        break
      }
      case 'shot': {
        const p = args[0] || `/tmp/shot-${Date.now()}.png`
        const out = await c.screenshot(p)
        console.log('saved', out)
        break
      }
      case 'switchTab': {
        const t = args[0]
        const v = await c.evalExpr(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo(${JSON.stringify(t)})`)
        console.log('tab:', t, '->', JSON.stringify(v))
        break
      }
      case 'select': {
        const id = args[0]
        const v = await c.evalExpr(`window.__dshRenderer && window.__dshRenderer.selectSession && window.__dshRenderer.selectSession(${JSON.stringify(id)})`)
        console.log('select:', id, '->', JSON.stringify(v))
        break
      }
      case 'sessions': {
        const v = await c.evalExpr('JSON.stringify(Array.from((window.__dshRenderer && window.__dshRenderer.snapshotState && window.__dshRenderer.snapshotState().sessions || new Map()).entries()).map(([id,m])=>({id,title:m.title,running:m.running,cached:(m.cachedEvents||[]).length,live:!!m.live,persisted:!!m.persisted})))')
        console.log(v)
        break
      }
      default:
        console.error('cmd?', cmd)
        process.exitCode = 2
    }
  } finally {
    c.close()
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1) })
