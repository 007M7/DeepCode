// scripts/qa-cdp-shoot-field-p0.mjs — Field §3 P0 收尾批 selfie driver
// (task-lead: "字段编排 P0 收尾批", 2026-07-17).
//
// Five shots that lock the residual field-viz-audit §3 P0 gaps. Three are
// already covered by fix/viz-p0-gaps (merged 378bfa9) and re-validated in
// the coverage report; the shots below are for the new work in this batch:
//
//   01-turn-end-error-line     — audit P0 #4. Turn/end system line now
//                                emits the FULL concat `turn ended: error
//                                at step 3: <message> [<code>]`, truncated
//                                past 120 chars with the full string on
//                                the hover title. Left-anchored, no second
//                                detail line. Wire:
//                                packages/core/session/src/types.ts
//                                TurnEndReasonMap.error.
//   02-turn-end-rejected-line  — audit P0 #4 sibling. `turn ended:
//                                rejected: <reason>` with warn severity
//                                tint. Confirms formatTurnEndLine covers
//                                every reason variant, not just error.
//   03-session-finished-error  — audit P0 #10. `session finished (error):
//                                error at step 5: <message> [<code>]` in
//                                the stream with error tint. Wire:
//                                packages/ui/jsonrpc/src/server.ts:157-161.
//   04-finish-reason-chip      — audit P0 #9. Trace-tree row shows a
//                                pill-shaped `max-tokens` chip next to
//                                the token badge on an assistant/chunk
//                                run. Wire:
//                                packages/llm/llm/src/types.ts:88
//                                chunk.type='finish'.reason.
//   05-cwd-attributes-runtime  — audit P0 #5. Trace-detail Attributes
//                                Runtime group shows a `cwd` row with
//                                the SessionHeader.cwd value. Wire:
//                                packages/core/session/src/types.ts:45
//                                SessionHeader.cwd.
//
// Usage:
//   node scripts/qa-cdp-shoot-field-p0.mjs <port> <outdir>

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9224'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-field-p0.mjs <port> <outdir>')
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
  const { play, wait = 400, hideDebugPanel = true, prep, clip } = opts
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
    clip: clip || { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
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
    // 01 — turn/end error full concat line.
    await shoot(c, '01-turn-end-error-line', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(function(){
          // Seed a user message so the stream isn't empty, then fire the
          // error turn/end mock.
          const sid = window.__dshRenderer.getActiveSessionId();
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'user/message', seq: 1, time: Date.now(),
            data: { content: [{ type: 'text', text: 'summarise the audit report' }],
                    source: 'user' },
          });
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'turn/start', seq: 2, time: Date.now(),
            data: { turn: 0, trigger: { kind: 'message', source: { kind: 'user' } } },
          });
          const btn = document.getElementById('mock-turn-end-error');
          if (!btn) return { err: 'mock button missing' };
          btn.click(); return { fired: 'mock-turn-end-error', sid };
        })()`)
      },
      wait: 500,
      prep: () => `(function(){
        const line = document.querySelector('.system.system-error');
        if (line && line.scrollIntoView) line.scrollIntoView({block:'center'});
        return { line: !!line, text: line ? line.textContent : null };
      })()`,
    })

    // 02 — turn/end rejected line (warn tone).
    await shoot(c, '02-turn-end-rejected-line', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(function(){
          const sid = window.__dshRenderer.getActiveSessionId();
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'user/message', seq: 1, time: Date.now(),
            data: { content: [{ type: 'text', text: 'delete /etc' }],
                    source: 'user' },
          });
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'turn/start', seq: 2, time: Date.now(),
            data: { turn: 0, trigger: { kind: 'message', source: { kind: 'user' } } },
          });
          document.getElementById('mock-turn-end-rejected').click();
          return { fired: 'mock-turn-end-rejected' };
        })()`)
      },
      wait: 500,
      prep: () => `(function(){
        const line = document.querySelector('.system.system-warn');
        if (line && line.scrollIntoView) line.scrollIntoView({block:'center'});
        return { line: !!line };
      })()`,
    })

    // 03 — session.finished error line with full reason.
    await shoot(c, '03-session-finished-error', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(function(){
          const sid = window.__dshRenderer.getActiveSessionId();
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'user/message', seq: 1, time: Date.now(),
            data: { content: [{ type: 'text', text: 'run the RFC pipeline' }],
                    source: 'user' },
          });
          document.getElementById('mock-session-finished-error').click();
          return { fired: 'mock-session-finished-error' };
        })()`)
      },
      wait: 500,
      prep: () => `(function(){
        const lines = document.querySelectorAll('.system.system-error');
        const last = lines[lines.length - 1];
        if (last && last.scrollIntoView) last.scrollIntoView({block:'center'});
        return { count: lines.length };
      })()`,
    })

    // 04 — chunk.finish max-tokens chip on trace row.
    await shoot(c, '04-finish-reason-chip', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(function(){
          const sid = window.__dshRenderer.getActiveSessionId();
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'user/message', seq: 1, time: Date.now(),
            data: { content: [{ type: 'text', text: 'write a haiku' }],
                    source: 'user' },
          });
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'turn/start', seq: 2, time: Date.now(),
            data: { turn: 0, trigger: { kind: 'message', source: { kind: 'user' } } },
          });
          document.getElementById('mock-finish-reason-run').click();
          window.__dshRenderer.onSessionEvent(sid, {
            type: 'turn/end', seq: 999, time: Date.now(),
            data: { turn: 0, reason: { kind: 'max-tokens' } },
          });
          return { fired: 'mock-finish-reason-run + turn/end' };
        })()`)
      },
      wait: 900,
      prep: () => `(function(){
        // Force every collapsible node in the trace tree open so the
        // finish chip and its assistant/chunk run row are visible in the
        // frame. The turn-trace-drawer lives inside the turn footer; open
        // it first, then every nested <details>.
        document.querySelectorAll('details.turn-trace-drawer, details.trace-event-row, details.trace-card, details.trace-run')
          .forEach(d => { d.open = true });
        // Also open the auto-added summary <details> wrappers around
        // chunk runs.
        document.querySelectorAll('.trace-event-row > details, .trace-run-body details')
          .forEach(d => { d.open = true });
        const chip = document.querySelector('.trace-event-finish-chip');
        if (chip && chip.scrollIntoView) chip.scrollIntoView({block:'center'});
        return { chipCount: document.querySelectorAll('.trace-event-finish-chip').length,
                 sampleText: chip ? chip.textContent : null };
      })()`,
    })

    // 05 — cwd in trace-detail Attributes Runtime group.
    await shoot(c, '05-cwd-attributes-runtime', {
      play: async () => {
        await ensureSession(c)
        return await c.evjs(`(async function(){
          const sid = window.__dshRenderer.getActiveSessionId();
          const meta = window.__dshRenderer.getSessionMeta(sid);
          if (meta) { meta.header = Object.assign({}, meta.header || {}, { cwd: '~/harness/dsh-desktop-demo' }); }
          const R = window.__dshRenderer;
          const t = Date.now();
          R.onSessionEvent(sid, { type: 'user/message', seq: 1, time: t,
            data: { content: [{ type: 'text', text: 'test cwd surface' }],
                    source: 'user' } });
          R.onSessionEvent(sid, { type: 'turn/start', seq: 2, time: t+5,
            data: { turn: 0, trigger: { kind: 'message', source: { kind: 'user' } } } });
          R.onSessionEvent(sid, { type: 'step/start', seq: 3, time: t+10,
            data: { turn: 0, step: 0 } });
          R.onSessionEvent(sid, { type: 'request/header', seq: 4, time: t+20,
            data: { reason: 'initial', header: { config: { model: 'deepseek-v4', temperature: 0.7 },
                                                 model: 'deepseek-v4', provider: 'deepseek' } } });
          R.onSessionEvent(sid, { type: 'assistant/message', seq: 5, time: t+50,
            data: { turn: 0, step: 0,
                    content: [{ type: 'text', text: 'ok' }],
                    usage: { inputTokens: 40, outputTokens: 6, reasoningTokens: 0,
                             cacheReadTokens: 0, cacheWriteTokens: 0 },
                    finish_reason: { kind: 'stop' } } });
          R.onSessionEvent(sid, { type: 'step/end', seq: 6, time: t+55,
            data: { turn: 0, step: 0 } });
          R.onSessionEvent(sid, { type: 'turn/end', seq: 7, time: t+60,
            data: { turn: 0, reason: { kind: 'completed' } } });
          return { fired: 'seeded turn with cwd on header', hadMeta: !!meta };
        })()`)
      },
      wait: 1200,
      prep: () => `(async function(){
        // Open every turn-trace-drawer so its tri-view mounts.
        document.querySelectorAll('details.turn-trace-drawer')
          .forEach(d => { d.open = true; });
        await new Promise(r => setTimeout(r, 300));
        // Click an assistant/message row (has attributes); fall back to any row.
        let row = document.querySelector('.trace-event-row[data-event-type="assistant/message"] summary')
               || document.querySelector('.trace-event-row summary');
        if (row) { row.click(); }
        await new Promise(r => setTimeout(r, 500));
        // Switch to Attributes tab (dataset.tab or textContent match).
        const tabs = Array.from(document.querySelectorAll('[data-tab], .trace-detail-tab, button.tab, [role="tab"]'));
        const attrTab = tabs.find(t => (t.dataset && t.dataset.tab === 'attributes')
                                      || ((t.textContent || '').trim().toLowerCase() === 'attributes'));
        if (attrTab) attrTab.click();
        await new Promise(r => setTimeout(r, 300));
        const groups = document.querySelectorAll('.trace-detail-attr-group');
        for (const g of groups) g.open = true;
        await new Promise(r => setTimeout(r, 150));
        // Correct row class is trace-detail-kv-row; key is trace-detail-kv-key.
        const cwdRow = Array.from(document.querySelectorAll('.trace-detail-attr-group.group-runtime .trace-detail-kv-row'))
          .find(el => {
            const k = el.querySelector('.trace-detail-kv-key');
            return k && (k.textContent || '').trim() === 'cwd';
          });
        if (cwdRow && cwdRow.scrollIntoView) cwdRow.scrollIntoView({block:'center'});
        return { rowClicked: !!row,
                 attrTab: !!attrTab,
                 groupCount: groups.length,
                 cwdRowFound: !!cwdRow,
                 cwdText: cwdRow ? cwdRow.textContent : null };
      })()`,
    })

    console.error('done')
  } finally {
    c.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
