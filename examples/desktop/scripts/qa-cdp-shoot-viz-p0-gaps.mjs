// scripts/qa-cdp-shoot-viz-p0-gaps.mjs — viz-coverage-matrix §5 P0-fill
// selfie driver (task-lead: "viz 覆盖矩阵 P0 缺口修复批", 2026-07-17).
//
// Three shots that lock the P0-fill visual contracts (matrix §5 rows 1–6):
//
//   01-prompt-blocked-row       — red-edge single-row card in the main
//                                  stream with `✗ prompt blocked · <reason>`
//                                  summary + expanded L1 body (raw text).
//                                  Wire: SessionEventMap['prompt/blocked']
//                                  (packages/core/session/src/types.ts:238).
//   02-approval-mode-dividers   — bash-tool card with inline
//                                  `✓ auto-allowed · preset ask-once`
//                                  note pinned in-block + two mode-divider
//                                  rows (`── sandbox → workspace-write ──`
//                                  and `── permission preset → headless ──`)
//                                  sitting in the stream. Wire:
//                                  approval/asked+decided (user-approval),
//                                  bash/sandbox-mode (session-mode.ts),
//                                  permission/preset (permission/index.ts).
//   03-subagent-stopreason-prose — sealed subagent card showing
//                                  `done · stop` in the head badge + prose
//                                  paragraph in RETURN (no ```json fence).
//                                  Wire: subagent.finished carrying
//                                  stopReason + lastAssistantMessage
//                                  (packages/ui/jsonrpc/src/server.ts:114-122).
//
// Usage:
//   node scripts/qa-cdp-shoot-viz-p0-gaps.mjs <port> <outdir>

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9224'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-viz-p0-gaps.mjs <port> <outdir>')
  process.exit(1)
}
mkdirSync(outdir, { recursive: true })

async function cdp() {
  const listRes = await fetch(`http://localhost:${port}/json/list`)
  const targets = await listRes.json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })
  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let msg; try { msg = JSON.parse(data) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id); pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message)); else ok(msg.result)
    }
  }
  const call = (m, p = {}, timeoutMs = 20000) => new Promise((ok, err) => {
    const _id = id++
    const t = setTimeout(() => { pending.delete(_id); err(new Error(`cdp timeout: ${m}`)) }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(t); ok(v) }, (e) => { clearTimeout(t); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evjs = async (js) => {
    const r = await call('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return { call, evjs, sleep, close: () => ws.close() }
}

async function ensureSession(c) {
  // Mint a fresh session so each shot starts from a clean stream.
  // Also force-switch to the chat tab first — Electron may restore a
  // previous tab (PRs/Growth/etc) from persisted state.
  return await c.evjs(`(async () => {
    if (window.__dshTabs && window.__dshTabs.switchTo) window.__dshTabs.switchTo('chat')
    const { id } = await window.dsh.newSession()
    if (window.__dshChat && window.__dshChat.selectSession) {
      await window.__dshChat.selectSession(id)
    }
    return id
  })()`)
}

async function shoot(cdp, name, opts) {
  const { play, wait = 400, hideDebugPanel = true, prep } = opts
  const played = await play()
  console.error(`[${name}] play -> ${JSON.stringify(played)}`)
  await cdp.sleep(wait)
  if (typeof prep === 'function') {
    const p = prep()
    if (p) { await cdp.evjs(p); await cdp.sleep(200) }
  }
  if (hideDebugPanel) {
    await cdp.evjs(`(function(){
      const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
      const d = document.querySelector('.devtools-drawer'); if (d) d.style.display='none'
      const rail = document.getElementById('context-rail-drawer'); if (rail) { rail.hidden = true; rail.style.display = 'none' }
      const pop = document.getElementById('debug-popover'); if (pop) pop.classList.remove('open')
      const ov = document.getElementById('onboarding');
      if (ov) { ov.style.display='none'; ov.hidden = true }
      return 1
    })()`)
  }
  const shot = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  const path = resolve(outdir, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(path)
}

async function main() {
  const c = await cdp()
  await c.call('Page.enable')
  const revealed = await c.evjs(`(async()=>{try{return window.dshQa && await window.dshQa.revealWindow()}catch(e){return {err: String(e)}}})()`)
  console.error(`reveal -> ${JSON.stringify(revealed)}`)
  await c.call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await c.evjs(`(function(){
    const overlay = document.getElementById('onboarding');
    if (overlay) { overlay.style.display = 'none'; overlay.hidden = true; }
    const rail = document.getElementById('context-rail-drawer');
    if (rail) { rail.hidden = true; rail.style.display = 'none' }
    return { overlayCleared: !!overlay };
  })()`)
  await c.evjs(`window.__dshTabs && window.__dshTabs.switchTo && window.__dshTabs.switchTo('chat')`)
  await c.sleep(300)

  try {
    // 01 — prompt/blocked row.
    // Mint a fresh session, click the P0 mock button that dispatches the
    // fake prompt/blocked event through the same VisibilityController
    // seam the live wire hits. Then force the <details> open so the L1
    // body (raw blocked prompt) is captured in the shot.
    await shoot(c, '01-prompt-blocked-row', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(function(){
          const btn = document.getElementById('mock-prompt-blocked');
          if (!btn) return { err: 'mock button missing' };
          btn.click(); return { fired: 'mock-prompt-blocked' };
        })()`)
      },
      wait: 400,
      prep: () => `(function(){
        const row = document.querySelector('.prompt-blocked-row');
        if (row) { row.open = true; if (row.scrollIntoView) row.scrollIntoView({block:'center'}); }
        return { row: !!row };
      })()`,
    })

    // 02 — approval note + mode dividers.
    // Sequence: seed a tool/call so the auto-allow can anchor into a real
    // .tool-block; fire approval-auto-allow; fire sandbox-switch; fire
    // preset-switch. All three surfaces appear in one screen.
    await shoot(c, '02-approval-mode-dividers', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(async function(){
          // Seed one bash tool/call so the auto-approve note has an anchor.
          const sid = window.__dshRendererState.activeSessionId;
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'tool/call', seq: 101, time: Date.now(),
            data: { callId: 'seed-bash-1', name: 'bash',
                    arguments: '{"cmd":"pnpm test"}' },
          });
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'tool/result', seq: 102, time: Date.now(),
            data: { callId: 'seed-bash-1',
                    content: [{ type: 'text', text: 'ok\\n8 tests passed' }],
                    isError: false, meta: { card: 'terminal', durationMs: 240,
                    stdout: 'ok\\n8 tests passed', exitCode: 0 } },
          });
          // Fire the three P0-2 mocks in order.
          document.getElementById('mock-approval-auto-allow').click();
          document.getElementById('mock-sandbox-switch').click();
          document.getElementById('mock-preset-switch').click();
          return { fired: ['bash-seed','auto-allow','sandbox-switch','preset-switch'] };
        })()`)
      },
      wait: 600,
      prep: () => `(function(){
        // Ensure the seeded tool block is open so the inline approval note is visible.
        const tool = document.querySelector('.tool-block[data-call-id="seed-bash-1"]');
        if (tool) tool.open = true;
        // Ensure the popover is closed so the header badges show cleanly.
        const pop = document.getElementById('debug-popover'); if (pop) pop.classList.remove('open');
        return { tool: !!tool };
      })()`,
    })

    // 03 — subagent stopReason + prose return backfill.
    // The mock button drives a full spawn → started → finished cycle with
    // stopReason='stop' and a plain-prose lastAssistantMessage (no ```json
    // fence). The sealed card must show "done · stop" in the head and
    // render RETURN as a prose paragraph, not <pre>.
    await shoot(c, '03-subagent-stopreason-prose', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(function(){
          const btn = document.getElementById('mock-subagent-plain-return');
          if (!btn) return { err: 'mock button missing' };
          btn.click();
          return { fired: 'mock-subagent-plain-return' };
        })()`)
      },
      wait: 600,
      prep: () => `(function(){
        // Open the spawn tool block, the sealed subagent trace, and the
        // return section so all three surfaces (head badge, meta segment,
        // prose paragraph) land in the frame.
        const tool = document.querySelector('.tool-block[data-call-id^="mock-spawn-"]');
        if (tool) tool.open = true;
        const trace = document.querySelector('.subagent-trace');
        if (trace) { trace.open = true; if (trace.scrollIntoView) trace.scrollIntoView({block:'center'}); }
        const ret = document.querySelector('.subagent-card-return');
        if (ret) ret.open = true;
        return { tool: !!tool, trace: !!trace, ret: !!ret };
      })()`,
    })

  } finally {
    c.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
