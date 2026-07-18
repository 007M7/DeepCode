// scripts/qa-cdp-shoot-rubric-prim.mjs — Rubric primitive selfies.
//
// Three shots proving the LangSmith FeedbackSchema-parity rubric batch:
//   rubric-prim-01  Annotation drawer scoring the multi-turn rubric —
//                   header carries the new Rubric picker (with the
//                   primitive-mix caption); the 5 continuous button rows
//                   render with type badges.
//   rubric-prim-02  Rubric picker flipped to the categorical primitive
//                   (intent-triage fixture) — enum button row + type
//                   badge (categorical).
//   rubric-prim-03  Rubrics page Create-from-scratch form open on the
//                   Continuous type — LangSmith "Creating new feedback
//                   config" popover parity (feedback tag + color dots +
//                   type dropdown + Min/Max).
//
// Usage:
//   node scripts/qa-cdp-shoot-rubric-prim.mjs <port> <outdir>

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [,, portArg, outdir] = process.argv
const port = portArg || '9241'
if (!outdir) {
  console.error('usage: node scripts/qa-cdp-shoot-rubric-prim.mjs <port> <outdir>')
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
  const call = (m, p = {}, timeoutMs = 60000) => new Promise((ok, err) => {
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
  return { call, evjs, sleep }
}

async function shoot(c, name, prep) {
  if (typeof prep === 'function') {
    const r = await c.evjs(prep())
    console.error('[' + name + '] prep ->', JSON.stringify(r))
    await c.sleep(500)
  }
  await c.evjs(`(function(){
    const p = document.querySelector('.debug-panel'); if (p) p.style.display='none'
    for (const sel of ['#context-rail-drawer', '#context-rail', '.context-rail-drawer', '.context-rail', '.devtools-drawer', '#devtools-panel']) {
      const n = document.querySelector(sel)
      if (n) { n.hidden = true; n.setAttribute('aria-hidden', 'true'); n.style.display = 'none' }
    }
    const ob = document.querySelector('#onboarding, .onboarding, [data-onboarding]')
    if (ob) ob.remove()
    return 1
  })()`)
  const shot = await c.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
  })
  const path = resolve(outdir, name + '.png')
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(path)
}

async function main() {
  const c = await cdp()
  await c.call('Page.enable')
  await c.evjs(`(async()=>{try{return window.dshQa && await window.dshQa.revealWindow()}catch(e){return {err: String(e)}}})()`)
  await c.call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  // Warm the Rubrics tab so window.__dshRubrics._state.rubrics is populated
  // (the picker dropdown reads from there).
  await c.evjs(`(async()=>{
    if (window.__dshTabs && window.__dshTabs.switchTo) window.__dshTabs.switchTo('rubrics')
    await new Promise(r=>setTimeout(r,500))
    if (window.__dshRubrics && window.__dshRubrics.refresh) await window.__dshRubrics.refresh()
    await new Promise(r=>setTimeout(r,300))
    return { n: (window.__dshRubrics && window.__dshRubrics._state && window.__dshRubrics._state.rubrics && window.__dshRubrics._state.rubrics.length) || 0 }
  })()`)

  // 01: annotation drawer scoring multi-turn (5 continuous dims + type badges).
  await shoot(c, 'rubric-prim-01-multiturn-continuous', () => `(async () => {
    const A = window.__dshAnnotation
    if (!A || !A.open) return { err: 'no __dshAnnotation.open' }
    // Reset to the default multi-turn rubric.
    if (A.setActiveRubric) {
      const list = (window.__dshRubrics && window.__dshRubrics._state && window.__dshRubrics._state.rubrics) || []
      const mt = list.find(r => r.template === 'multi-turn')
      if (mt) A.setActiveRubric(mt); else A.setActiveRubric({id:'__multi-turn__', name:'multi-turn (5 fixed dims)', template:'multi-turn'})
    }
    A.open('sess-fib-01')
    await new Promise(r=>setTimeout(r,600))
    // Pre-score first turn on a few dims so the buttons show "active" state.
    const model = window.__dshAnnotationModel
    if (model && model.setTurnScore) {
      let ann = A.read('sess-fib-01') || model.blankAnnotation('sess-fib-01')
      ann = model.setOverall(ann, 'good', Date.now())
      ann = model.setTurnScore(ann, 0, { dims: { 'feedback-understanding': 5, 'fix-effectiveness': 4, 'no-regression': 5 } }, Date.now())
      A._state.byId.set('sess-fib-01', ann)
      // Re-render the drawer body via close/open cycle would reset focus;
      // simpler: dispatch the update event which is what triview listens on.
      document.dispatchEvent(new CustomEvent('dsh:annotation-updated', { detail: { sessionId: 'sess-fib-01', ann } }))
      // Force a fresh renderBody by re-opening.
      A.close && A.close()
      await new Promise(r=>setTimeout(r,150))
      A.open('sess-fib-01')
      await new Promise(r=>setTimeout(r,400))
    }
    return { badges: document.querySelectorAll('.annotation-dim-type-badge').length }
  })()`)

  // 02: switch drawer to categorical (intent-triage rubric).
  await shoot(c, 'rubric-prim-02-categorical', () => `(async () => {
    const A = window.__dshAnnotation
    const list = (window.__dshRubrics && window.__dshRubrics._state && window.__dshRubrics._state.rubrics) || []
    const cat = list.find(r => r.dimensions && r.dimensions.some(d => d.type === 'categorical'))
    if (!cat) return { err: 'no categorical fixture' }
    A.setActiveRubric(cat)
    if (A.close) A.close()
    await new Promise(r=>setTimeout(r,120))
    A.open('sess-fib-01')
    await new Promise(r=>setTimeout(r,400))
    return { active: A.getActiveRubric && A.getActiveRubric().name, dimTypes: (A.getActiveDims && A.getActiveDims().map(d=>d.type).join(',')) || '' }
  })()`)

  // 03: rubrics page Create-from-scratch form.
  await shoot(c, 'rubric-prim-03-create-form', () => `(async () => {
    const A = window.__dshAnnotation
    if (A && A.close) A.close()
    await new Promise(r=>setTimeout(r,120))
    if (window.__dshTabs && window.__dshTabs.switchTo) window.__dshTabs.switchTo('rubrics')
    await new Promise(r=>setTimeout(r,400))
    const R = window.__dshRubrics
    if (!R || !R.openCreateForm) return { err: 'no openCreateForm' }
    R.openCreateForm('llm-judge')
    await new Promise(r=>setTimeout(r,500))
    // Scroll the form into view so it lands in the shot.
    const f = document.querySelector('.rubric-create-form')
    if (f && f.scrollIntoView) { try { f.scrollIntoView({ block: 'center' }) } catch (_) {} }
    await new Promise(r=>setTimeout(r,300))
    return { open: !!document.querySelector('.rubric-create-form') }
  })()`)

  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
