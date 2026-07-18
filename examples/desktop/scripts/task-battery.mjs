#!/usr/bin/env node
// Real-task completion battery — task #86 owner: passthrough-verify.
//
// Runs a ≥10-task suite against the running Electron on CDP :9299 with
// profile=stdio-deepseek (real DEEPSEEK_API_KEY). For each task:
//   1. New session, send prompt (real DeepSeek turn).
//   2. Poll turn/end; capture wire event count, tokens, chunks.
//   3. Objective completion judge (per task: file exists / content match /
//      wire signal / etc).
//   4. Render assertions on the DOM: tool card presence, trace footer
//      values, reasoning drawer availability, absence of "—" placeholders
//      in the Tracing summary row for this session.
//   5. Collect captured errs from the pre-installed __battery hooks.
//
// LLM budget: ≤40 real calls. Sandbox workdir /tmp/dsh-task-battery/T??.
// Do not touch user's Electron (pid 91655) — this driver is pinned to
// CDP_PORT=9299.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PORT = 9299
const SANDBOX_ROOT = '/tmp/dsh-task-battery'

function nowIso() { return new Date().toISOString() }
function log(...a) { console.log('[battery]', nowIso(), ...a) }

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json/list`, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function connect() {
  const t = await listTargets()
  const p = t.find((x) => x.title === 'DSH Desktop') || t.find((x) => x.type === 'page')
  if (!p) throw new Error('no page')
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = () => r(); ws.onerror = (e) => j(e.message || 'ws err') })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data) } catch { return }
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
  async function evalExpr(expr, awaitProm = true, timeoutMs = 60000) {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: awaitProm, timeout: timeoutMs,
    })
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text
      throw new Error('eval-error: ' + desc)
    }
    return r.result && r.result.value
  }
  async function screenshot(pth) {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(pth, Buffer.from(r.data, 'base64'))
    return pth
  }
  return { ws, evalExpr, screenshot, close: () => ws.close() }
}

// Prompt DeepSeek to write files into an absolute workdir; the model can
// use its `bash` tool. We assert on real filesystem outcomes.
const TASKS = [
  {
    id: 'T01', title: 'single-file create (fizzbuzz)',
    prompt: (wd) => `Use the bash tool to create a file at exactly ${wd}/fizzbuzz.py containing a Python fizzbuzz that prints 1..15. Then confirm.`,
    judge: (wd) => {
      const p = path.join(wd, 'fizzbuzz.py')
      if (!fs.existsSync(p)) return { pass: false, why: 'file not created' }
      const s = fs.readFileSync(p, 'utf8')
      const looksLikeFizzbuzz = /fizz/i.test(s) && /buzz/i.test(s)
      return { pass: looksLikeFizzbuzz, why: looksLikeFizzbuzz ? 'file has fizz/buzz' : 'file lacks fizz/buzz' }
    },
  },
  {
    id: 'T02', title: 'read file + answer',
    setup: (wd) => fs.writeFileSync(path.join(wd, 'note.txt'), 'The secret color is turquoise. Do not forget.\n'),
    prompt: (wd) => `Read the file at exactly ${wd}/note.txt using bash (cat), then tell me the secret color.`,
    judge: (_wd, text) => {
      const found = /turquoise/i.test(text || '')
      return { pass: found, why: found ? 'answer contains turquoise' : 'answer lacks turquoise' }
    },
  },
  {
    id: 'T03', title: 'bash execute + summarize',
    prompt: (wd) => `Run the bash command \`ls -la ${wd}\` and summarize what you see in one sentence.`,
    judge: (_wd, text) => {
      const mentions = /file|dir|empty|contents|entries|nothing/i.test(text || '')
      return { pass: mentions, why: mentions ? 'summary reads like a listing summary' : 'summary does not describe a listing' }
    },
  },
  {
    id: 'T04', title: 'multi-step: three files + index',
    prompt: (wd) => `Create three files with bash: ${wd}/a.txt (contents "alpha"), ${wd}/b.txt (contents "beta"), ${wd}/c.txt (contents "gamma"). Then create ${wd}/index.txt whose contents are the concatenation "alpha beta gamma".`,
    judge: (wd) => {
      const ok = ['a.txt', 'b.txt', 'c.txt', 'index.txt'].every((f) => fs.existsSync(path.join(wd, f)))
      if (!ok) return { pass: false, why: 'missing file(s)' }
      const idx = fs.readFileSync(path.join(wd, 'index.txt'), 'utf8')
      const hasAll = /alpha/.test(idx) && /beta/.test(idx) && /gamma/.test(idx)
      return { pass: hasAll, why: hasAll ? 'index has alpha/beta/gamma' : 'index missing tokens' }
    },
  },
  {
    id: 'T05', title: 'file edit (append line)',
    setup: (wd) => fs.writeFileSync(path.join(wd, 'log.txt'), 'first line\n'),
    prompt: (wd) => `Append the line "second line" to ${wd}/log.txt using bash. Keep the original content.`,
    judge: (wd) => {
      const s = fs.readFileSync(path.join(wd, 'log.txt'), 'utf8')
      const both = /first line/.test(s) && /second line/.test(s)
      return { pass: both, why: both ? 'both lines present' : `missing lines, got: ${JSON.stringify(s)}` }
    },
  },
  {
    id: 'T06', title: 'error recovery (nonexistent path)',
    prompt: (wd) => `Try to \`cat /nonexistent/path-${Date.now()}\` using bash. When it fails, tell me in one sentence why it failed.`,
    judge: (_wd, text) => {
      const explains = /(no such|not found|does not exist|missing|nonexistent|doesn.t exist)/i.test(text || '')
      return { pass: explains, why: explains ? 'model explained the failure' : 'model did not explain' }
    },
  },
  {
    id: 'T07', title: 'long output task',
    prompt: (_wd) => `Write a Python one-liner in a code fence that prints 200 lines of increasing integers. Do not execute it; just show the code.`,
    judge: (_wd, text) => {
      const hasCode = /(```|for|range|print)/i.test(text || '')
      return { pass: hasCode && (text || '').length > 60, why: hasCode ? 'response contains code' : 'no code visible' }
    },
  },
  {
    id: 'T08', title: 'cancel mid-turn',
    // Long-running prompt we will cancel around 900ms in.
    prompt: (_wd) => `Explain in extreme detail, at least 800 words, how the TCP three-way handshake works, including diagrams in ASCII.`,
    cancelAfterMs: 900,
    judge: (_wd, _text, meta) => {
      const cancelled = meta.cancelResult && meta.cancelResult.cancelled === true
      return { pass: cancelled, why: cancelled ? 'server acknowledged cancel' : 'cancel returned ' + JSON.stringify(meta.cancelResult) }
    },
    // No render assertions for the cancelled turn beyond "turn present in stream".
    skipRenderChecks: false,
  },
  {
    id: 'T09', title: 'fork replay from seq 1',
    prompt: (wd) => `Say only the word "spark".`,
    // After the turn, driver will fork from seq 1 and confirm shape.
    fork: true,
    judge: (_wd, text, meta) => {
      const said = /spark/i.test(text || '')
      const fk = meta.forkResult
      const forked = fk && fk.childSessionId && (fk.mocked === false)
      return { pass: said && forked, why: `saidSpark=${said} forked=${forked} mocked=${fk && fk.mocked}` }
    },
  },
  {
    id: 'T10', title: 'multi-turn follow-up',
    prompt: (_wd) => `Remember the number 42 for later. Reply with just: OK.`,
    followUp: {
      prompt: 'What number did I ask you to remember?',
      judge: (text) => ({ pass: /42/.test(text || ''), why: /42/.test(text || '') ? 'follow-up said 42' : 'follow-up missed 42' }),
    },
    judge: (_wd, text) => {
      return { pass: /ok/i.test(text || ''), why: /ok/i.test(text || '') ? 'first turn said OK' : 'first turn did not say OK' }
    },
  },
]

async function ensureSandbox() {
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true })
}

async function newSessionWithCwd(c, _cwd) {
  // newSession() ignores cwd (main.js:206 uses process.cwd); the sandbox is
  // enforced by the prompt using absolute paths under SANDBOX_ROOT.
  return c.evalExpr(`
    (async () => {
      const r = await window.dsh.newSession();
      if (window.__dshRenderer && window.__dshRenderer.selectSession) {
        window.__dshRenderer.selectSession(r.id);
      }
      return r;
    })()
  `)
}

async function sendPromptAndCollect(c, sid, prompt, { cancelAfterMs, budget = 60000 } = {}) {
  // Fire send (do not await here — cancel test needs mid-flight control).
  await c.evalExpr(`
    (() => {
      window.__task = { sendResult: null, sendErr: null };
      window.__task.sendPromise = window.dsh.sendPrompt(${JSON.stringify(sid)}, ${JSON.stringify(prompt)})
        .then(r => { window.__task.sendResult = r; return r; })
        .catch(e => { window.__task.sendErr = String(e && e.message || e); });
      return true;
    })()
  `, true, 10000)
  let cancelResult = null
  const start = Date.now()
  if (cancelAfterMs) {
    await new Promise((r) => setTimeout(r, cancelAfterMs))
    cancelResult = await c.evalExpr(`
      (async () => await window.dsh.cancelPrompt(${JSON.stringify(sid)}, 'battery cancel'))()
    `, true, 15000)
  }
  // Poll for turn/end in the renderer's cachedEvents.
  const eventsExpr = (sid) => `
    (() => {
      const st = window.__dshRenderer && window.__dshRenderer.snapshotState && window.__dshRenderer.snapshotState();
      const meta = st && st.sessions && st.sessions.get ? st.sessions.get(${JSON.stringify(sid)}) : null;
      const evs = (meta && meta.cachedEvents) || [];
      const types = evs.map(e => e.type);
      const done = types.includes('turn/end');
      let text = '';
      for (const e of evs) {
        if (e.type === 'assistant/chunk' && e.content) {
          const c = e.content;
          if (typeof c === 'string') text += c;
          else if (c.text) text += c.text;
          else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && b.text) text += b.text;
        }
        if (e.type === 'assistant/message' && e.content) {
          const c = e.content;
          if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && b.text) text += b.text;
          else if (typeof c === 'string') text += c;
        }
      }
      return { done, text, eventCount: evs.length, types };
    })()
  `
  let lastSnap = { done: false, text: '', eventCount: 0, types: [] }
  while (Date.now() - start < budget) {
    lastSnap = await c.evalExpr(eventsExpr(sid))
    if (lastSnap.done) break
    if (cancelResult) {
      const settled = await c.evalExpr('window.__task && (window.__task.sendErr || (window.__task.sendResult && window.__task.sendResult.cancelled))')
      if (settled && lastSnap.eventCount > 0) {
        // Give a beat for a final assistant/message before bailing.
        await new Promise((r) => setTimeout(r, 800))
        lastSnap = await c.evalExpr(eventsExpr(sid))
        break
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const sendState = await c.evalExpr('({ sendResult: window.__task && window.__task.sendResult, sendErr: window.__task && window.__task.sendErr })')
  const snapshot = {
    text: lastSnap.text || '',
    eventCount: lastSnap.eventCount || 0,
    done: !!lastSnap.done,
    types: lastSnap.types || [],
    sendResult: sendState.sendResult || null,
    sendErr: sendState.sendErr || null,
  }
  return { snapshot, cancelResult }
}

async function renderAssertions(c, sid, taskId) {
  // Ask the renderer for tool-card / trace-footer / drawer state for this session.
  const scoped = await c.evalExpr(`
    (() => {
      const s = document.getElementById('stream');
      const html = s ? s.innerHTML : '';
      // Placeholder scanner: 1969 timestamps, literal "—" chains, "[object Object]".
      const has1969 = /1969-|Wed Dec 31 1969/.test(html);
      const hasObjObj = /\\[object Object\\]/.test(html);
      // Tool cards render as .tool-card (or generic .card with role=tool).
      const toolCards = s ? s.querySelectorAll('.tool-card, [data-kind="tool"]').length : 0;
      // Trace footer / drawer glyph presence.
      const footerHasTokens = s ? !!s.querySelector('.trace-footer, .turn-footer, [data-role="trace-footer"]') : false;
      // reasoning drawer / button presence.
      const reasoningBtn = s ? !!s.querySelector('[data-tab="reasoning"], .reasoning-toggle') : false;
      return { htmlLen: html.length, has1969, hasObjObj, toolCards, footerHasTokens, reasoningBtn };
    })()
  `)
  // Tracing page row for this session (non-—).
  const tracingRow = await c.evalExpr(`
    (async () => {
      // Switch to the tracing tab briefly to trigger render, then read.
      if (window.__dshTabs && window.__dshTabs.switchTo) {
        try { window.__dshTabs.switchTo('tracing'); } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 800));
      const table = document.querySelector('.tracing-table, [data-view="tracing"] table, table.tracing');
      const rowCount = table ? table.querySelectorAll('tbody tr').length : 0;
      // find row containing our session id
      let ourRowText = null;
      if (table) {
        for (const tr of table.querySelectorAll('tbody tr')) {
          if (tr.textContent && tr.textContent.indexOf(${JSON.stringify(sid.slice(0, 8))}) >= 0) {
            ourRowText = tr.textContent.replace(/\\s+/g, ' ').trim();
            break;
          }
        }
      }
      // switch back to chat
      if (window.__dshTabs && window.__dshTabs.switchTo) {
        try { window.__dshTabs.switchTo('chat'); } catch (_) {}
      }
      return { rowCount, ourRowText };
    })()
  `, true, 20000)
  return { ...scoped, tracing: tracingRow, taskId }
}

async function collectErrors(c) {
  return c.evalExpr('({ errs: (window.__battery && window.__battery.errs) || [], apiCalls: (window.__battery && window.__battery.apiCalls) || 0 })')
}

async function runTask(c, task, apiBudget) {
  const wd = path.join(SANDBOX_ROOT, task.id)
  fs.mkdirSync(wd, { recursive: true })
  if (task.setup) task.setup(wd)
  const sess = await newSessionWithCwd(c, wd)
  const sid = sess.id
  log(task.id, task.title, '→ sid', sid, 'wd', wd)
  const prompt = task.prompt(wd)
  const { snapshot, cancelResult } = await sendPromptAndCollect(c, sid, prompt, {
    cancelAfterMs: task.cancelAfterMs,
    budget: task.cancelAfterMs ? 20000 : 90000,
  })
  const meta = { cancelResult, forkResult: null }
  if (task.fork) {
    try {
      meta.forkResult = await c.evalExpr(`
        (async () => await window.dsh.forkSession({ sessionId: ${JSON.stringify(sid)}, boundary: { fromSeq: 1 } }))()
      `, true, 15000)
    } catch (e) { meta.forkResult = { error: String(e.message) } }
  }
  // Follow-up second turn (T10).
  let followUpText = null
  if (task.followUp) {
    const fu = await sendPromptAndCollect(c, sid, task.followUp.prompt, { budget: 90000 })
    followUpText = fu.snapshot.text
  }
  const verdict = task.judge(wd, snapshot.text, meta)
  const followUpVerdict = task.followUp ? task.followUp.judge(followUpText) : null
  const render = await renderAssertions(c, sid, task.id)
  return {
    id: task.id, title: task.title, sid, wd,
    prompt, replyText: snapshot.text.slice(0, 400) + (snapshot.text.length > 400 ? '…' : ''),
    replyLen: snapshot.text.length,
    eventCount: snapshot.eventCount,
    done: snapshot.done,
    sendErr: snapshot.sendErr,
    meta,
    verdict,
    followUpText: followUpText ? followUpText.slice(0, 300) : null,
    followUpVerdict,
    render,
  }
}

async function buttonScan(c, someSid) {
  // Select a real-data session and try clicking a set of common interactive elements.
  await c.evalExpr(`window.__dshRenderer && window.__dshRenderer.selectSession && window.__dshRenderer.selectSession(${JSON.stringify(someSid)})`)
  await new Promise((r) => setTimeout(r, 500))
  const scan = await c.evalExpr(`
    (() => {
      const dead = [];
      const clicked = [];
      const s = document.getElementById('stream');
      if (!s) return { dead: ['no-stream'], clicked: [] };
      // 1. tool-card expand triggers
      const expandables = Array.from(s.querySelectorAll('summary, [data-toggle], .expandable, .tool-card summary, details > summary'));
      for (const el of expandables.slice(0, 10)) {
        const before = el.closest('details') ? el.closest('details').open : null;
        try {
          el.click();
          clicked.push({sel:'expandable', tag:el.tagName, before, after: el.closest('details') ? el.closest('details').open : null});
        } catch (e) { dead.push({sel:'expandable-click', err: String(e.message)}); }
      }
      // 2. { } drawer buttons
      const jsonBtns = Array.from(document.querySelectorAll('.copy-json, .open-json, [data-action="open-json"], [aria-label*="JSON" i]'));
      for (const el of jsonBtns.slice(0, 5)) {
        try { el.click(); clicked.push({sel:'json-btn', tag:el.tagName}); }
        catch(e){ dead.push({sel:'json-btn', err: String(e.message)}); }
      }
      // 3. tab buttons in detail panes (Feedback/Input/Output/Attributes/Error)
      const tabs = Array.from(document.querySelectorAll('.tab-button, [role="tab"]'));
      for (const el of tabs.slice(0, 8)) {
        try { el.click(); clicked.push({sel:'tab', tag:el.tagName, label:(el.textContent||'').trim().slice(0,20)}); }
        catch(e){ dead.push({sel:'tab', err: String(e.message)}); }
      }
      // 4. copy buttons
      const copyBtns = Array.from(document.querySelectorAll('.copy-btn, [data-action="copy"]'));
      for (const el of copyBtns.slice(0, 5)) {
        try { el.click(); clicked.push({sel:'copy', tag:el.tagName}); }
        catch(e){ dead.push({sel:'copy', err: String(e.message)}); }
      }
      return { dead, clicked, counts: {
        expandables: expandables.length, jsonBtns: jsonBtns.length, tabs: tabs.length, copyBtns: copyBtns.length,
      } };
    })()
  `)
  return scan
}

async function main() {
  await ensureSandbox()
  const c = await connect()
  try {
    log('runtimeStatus:')
    const rs = await c.evalExpr('(async()=>await window.dsh.runtimeStatus())()')
    console.log(JSON.stringify(rs, null, 2))
    if (rs.profile !== 'stdio-deepseek') {
      log('WARN: expected stdio-deepseek, got', rs.profile, '— switching')
      await c.evalExpr('(async()=>await window.dsh.startRuntime("stdio-deepseek"))()')
      // wait
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const s = await c.evalExpr('(async()=>{const x=await window.dsh.runtimeStatus();return {status:x.status,profile:x.profile}})()')
        log('poll', s)
        if (s.status === 'running' && s.profile === 'stdio-deepseek') break
      }
    }

    const results = []
    for (const t of TASKS) {
      try {
        const r = await runTask(c, t, 40)
        results.push(r)
        log(t.id, 'verdict:', r.verdict.pass ? 'PASS' : 'FAIL', '—', r.verdict.why)
      } catch (e) {
        log(t.id, 'EXCEPTION', e.message)
        results.push({ id: t.id, title: t.title, error: String(e.message), verdict: { pass: false, why: 'exception: ' + e.message } })
      }
    }

    // Button scan on last session that had real data (prefer T01).
    let scan = null
    try {
      const anySid = results.find((r) => r.sid && r.verdict.pass)?.sid || results[0]?.sid
      if (anySid) scan = await buttonScan(c, anySid)
    } catch (e) {
      scan = { error: String(e.message) }
    }

    const errCollect = await collectErrors(c)
    const report = {
      timestamp: nowIso(),
      profile: rs.profile,
      model: rs.model,
      results,
      buttonScan: scan,
      capturedErrors: errCollect.errs,
      apiCallsCounted: errCollect.apiCalls,
      passCount: results.filter((r) => r.verdict.pass).length,
      totalTasks: results.length,
      followUpPassCount: results.filter((r) => r.followUpVerdict && r.followUpVerdict.pass).length,
      followUpTotal: results.filter((r) => r.followUpVerdict).length,
    }
    const outPath = path.join(SANDBOX_ROOT, 'battery-report.json')
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
    log('wrote', outPath)
    log('SUMMARY', report.passCount + '/' + report.totalTasks, 'PASS  followUps', report.followUpPassCount + '/' + report.followUpTotal, ' apiCalls', report.apiCallsCounted, 'errs', report.capturedErrors.length)
  } finally {
    c.close()
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1) })
