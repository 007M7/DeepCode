// qa-trace-signals-fixture.mjs — headless SVG proof for lane-trace-signals.
//
// The Electron shoot (qa-trace-signals-shoot.mjs) can't run in the CI env
// (electron isn't installed there — that's the same story as the
// pre-existing artifact-server.test.js failure). This script drives the
// same rendering code paths through node's require system, then writes
// three standalone HTML files that show the exact SVG output the Timeline
// and Graph produce. Open them in a browser to see the badges/rings/chips
// exactly as the real app would render them.
//
// Output (default: docs/trace-signals-shoot/):
//   signals-01-timeline-loop.html
//   signals-02-graph-error.html
//   signals-03-chips-plan.html

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const outdir = process.argv[2] || resolve(__dirname, '..', 'docs', 'trace-signals-shoot')
mkdirSync(outdir, { recursive: true })

const T = require(resolve(__dirname, '..', 'src', 'renderer', 'trace-timeline.js'))
const G = require(resolve(__dirname, '..', 'src', 'renderer', 'trace-graph.js'))
const SD = require(resolve(__dirname, '..', 'src', 'renderer', 'trace-signal-detect.js'))

// Node has no document; hand-roll a minimal serializer over the same shape
// the renderer builds. This mirrors the test-shim in test/trace-signal-*.
function makeDoc() {
  function makeEl(tagOrNS, tag) {
    const cls = new Set()
    const el = {
      tagName: (tag || tagOrNS).toLowerCase(),
      isSvg: !!tag && tagOrNS === 'http://www.w3.org/2000/svg',
      _children: [], _attrs: {}, _cls: cls,
      textContent: '',
      dataset: {},
      style: {},
      get className() { return Array.from(cls).join(' ') },
      set className(v) { cls.clear(); String(v || '').split(/\s+/).forEach(x => x && cls.add(x)) },
      classList: {
        add(c) { cls.add(c) }, remove(c) { cls.delete(c) },
        toggle(c, on) { if (on) cls.add(c); else cls.delete(c) },
        contains(c) { return cls.has(c) },
      },
      appendChild(c) { this._children.push(c); return c },
      append(...cs) { for (const c of cs) this._children.push(c) },
      insertBefore(node) { this._children.unshift(node); return node },
      setAttribute(k, v) {
        this._attrs[k] = String(v)
        if (k === 'class') {
          cls.clear()
          String(v || '').split(/\s+/).forEach(x => x && cls.add(x))
        }
      },
      getAttribute(k) { return this._attrs[k] },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null }, querySelectorAll() { return [] },
    }
    return el
  }
  return {
    createElement(t) { return makeEl(t) },
    createElementNS(ns, t) { return makeEl(ns, t) },
    body: makeEl('body'),
  }
}

function serialize(el) {
  if (!el) return ''
  if (typeof el === 'string') return el
  const tag = el.tagName
  const cls = el.className
  const attrs = []
  for (const [k, v] of Object.entries(el._attrs || {})) {
    if (k === 'class') continue
    attrs.push(`${k}="${escapeHtml(v)}"`)
  }
  if (cls) attrs.push(`class="${escapeHtml(cls)}"`)
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : ''
  const kids = (el._children || []).map(serialize).join('')
  const text = el.textContent && (!el._children || !el._children.length) ? escapeHtml(el.textContent) : ''
  return `<${tag}${attrStr}>${text}${kids}</${tag}>`
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function pageWrap(title, body, note) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font: 13px system-ui, sans-serif; margin: 24px; background: #f9fafb; color: #1d1d1f; }
  h1 { font-size: 15px; margin: 0 0 8px 0; }
  .note { color: #6b6b70; font-size: 12px; margin: 0 0 16px 0; max-width: 720px; line-height: 1.4; }
  .stage { background: #fff; padding: 16px; border: 1px solid #e5e5ea; border-radius: 8px; overflow-x: auto; }
  /* Palette matches src/renderer/style.css tail block for signal badges/rings/chips. */
  .trace-timeline-svg { font: 11px system-ui, sans-serif; }
  .trace-timeline-tick { stroke: #d0d0d5; stroke-width: 0.5; stroke-dasharray: 2 3; }
  .trace-timeline-tick-label { fill: #6b6b70; font-size: 10px; }
  .trace-timeline-label { fill: #1d1d1f; font-size: 11px; }
  .trace-timeline-bar.family-step { fill: #b0b4bd; }
  .trace-timeline-bar.family-llm { fill: #7c3aed; }
  .trace-timeline-bar.family-tool { fill: #b45309; }
  .trace-timeline-bar.family-input { fill: #6b6b70; }
  .trace-timeline-signal-badge { stroke: rgba(0,0,0,0.15); stroke-width: 0.75; }
  .trace-timeline-signal-badge.sig-error    { fill: #dc2626; }
  .trace-timeline-signal-badge.sig-loop     { fill: #ef4444; }
  .trace-timeline-signal-badge.sig-redundant{ fill: #f59e0b; }
  .trace-timeline-signal-badge.sig-plan     { fill: #2563eb; }
  .trace-graph-svg { background: #fff; }
  .trace-graph-node-body { fill: #f3f4f6; stroke: #9ca3af; stroke-width: 1; }
  .trace-graph-node-body.family-tool { fill: #fde68a; stroke: #b45309; }
  .trace-graph-node-body.family-step { fill: #e5e7eb; stroke: #6b7280; }
  .trace-graph-node-body.family-llm { fill: #ddd6fe; stroke: #7c3aed; }
  .trace-graph-node-glyph { font: 12px system-ui, sans-serif; fill: #1d1d1f; }
  .trace-graph-node-label { font: 10px system-ui, sans-serif; fill: #1d1d1f; }
  .trace-graph-edge { stroke: #9ca3af; stroke-width: 1.2; }
  .trace-graph-signal-ring { stroke-width: 2.5; fill: none; }
  .trace-graph-signal-ring.sig-error    { stroke: #dc2626; }
  .trace-graph-signal-ring.sig-loop     { stroke: #ef4444; }
  .trace-graph-signal-ring.sig-plan     { stroke: #2563eb; }
  .assistant-turn { border-left: 3px solid #d0d0d5; padding: 12px; margin: 12px 0; background: #fff; border-radius: 6px; }
  .turn-body { display: flex; flex-direction: column; gap: 6px; }
  .text-block { font-size: 13px; color: #1d1d1f; }
  .tool-row { font-family: ui-monospace, monospace; font-size: 12px; color: #4b5563; }
  .turn-glyph { display: inline-block; width: 14px; }
  .turn-signal-chip-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0 6px 0; align-items: center; }
  .turn-signal-chip { font-size: 11px; line-height: 1; padding: 3px 8px; border-radius: 10px; border: 1px solid transparent; background: rgba(0,0,0,0.03); color: #1d1d1f; cursor: pointer; font-family: inherit; }
  .turn-signal-chip::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; background: currentColor; }
  .turn-signal-chip.sig-error, .turn-signal-chip.sig-loop { color: #b91c1c; border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.06); }
  .turn-signal-chip.sig-redundant { color: #92400e; border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.08); }
  .turn-signal-chip.sig-plan { color: #1d4ed8; border-color: rgba(37,99,235,0.35); background: rgba(37,99,235,0.06); }
</style>
</head><body>
  <h1>${escapeHtml(title)}</h1>
  <p class="note">${note}</p>
  <div class="stage">${body}</div>
</body></html>`
}

// ─── shot 1 — Timeline with a loop-detected badge on seq 12 ──────────
{
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 10, endSeq: 15,
    startTime: 1000, endTime: 1500, durationMs: 500,
    summary: 'read main.ts',
    inputs: [], outputs: [],
    events: [
      { type: 'tool/call', seq: 11, time: 1050, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c1' } },
      { type: 'tool/result', seq: 11.5, time: 1080, data: { callId: 'c1', ok: true } },
      { type: 'tool/call', seq: 12, time: 1150, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c2' } },
      { type: 'tool/result', seq: 12.5, time: 1180, data: { callId: 'c2', ok: true } },
      { type: 'tool/call', seq: 13, time: 1250, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c3' } },
      { type: 'tool/result', seq: 13.5, time: 1280, data: { callId: 'c3', ok: true } },
    ],
  }
  const { bySeq, all } = SD.detectSignalsFromRecords(rec, { loopN: 3 })
  const el = T.renderTimeline(doc, rec, { signals: bySeq, width: 820 })
  const html = pageWrap(
    'Signals 01 — Timeline: loop-detected badge',
    serialize(el),
    'Three consecutive <code>fs.read</code> calls with identical args. The detector fires <code>loop-detected</code> on the third call; its badge sits in the left gutter, colored red. Signals detected: <code>' + all.map(s => s.signal).join(', ') + '</code>. See docs/upstream-ledger.md L-2.',
  )
  writeFileSync(resolve(outdir, 'signals-01-timeline-loop.html'), html)
  console.log('wrote', resolve(outdir, 'signals-01-timeline-loop.html'))
}

// ─── shot 2 — Graph with a tool-error ring around the failing call ───
{
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 10, endSeq: 14,
    startTime: 1000, endTime: 1500, durationMs: 500,
    summary: 'bash checks',
    inputs: [], outputs: [],
    events: [
      { type: 'tool/call', seq: 11, time: 1050, data: { name: 'bash', arguments: 'ls /nope', callId: 'c1' } },
      { type: 'tool/result', seq: 12, time: 1080, data: { callId: 'c1', ok: false, error: 'ENOENT' } },
      { type: 'tool/call', seq: 13, time: 1150, data: { name: 'bash', arguments: 'ls /tmp', callId: 'c2' } },
      { type: 'tool/result', seq: 14, time: 1180, data: { callId: 'c2', ok: true } },
    ],
  }
  const { bySeq, all } = SD.detectSignalsFromRecords(rec)
  const el = G.renderGraph(doc, rec, { signals: bySeq })
  const html = pageWrap(
    'Signals 02 — Graph: tool-error ring',
    serialize(el),
    'A failing <code>bash</code> call followed by a successful retry. The detector emits <code>tool-error</code> on the failing call\'s seq and <code>plan-restart</code> on the retry. The Graph node for the failing call gets a red outer ring; the retry node gets a blue ring. Signals detected: <code>' + all.map(s => s.signal).join(', ') + '</code>.',
  )
  writeFileSync(resolve(outdir, 'signals-02-graph-error.html'), html)
  console.log('wrote', resolve(outdir, 'signals-02-graph-error.html'))
}

// ─── shot 3 — Assistant turn with signal chip row ────────────────────
{
  const events = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, time: 1050, data: { content: [{ type: 'text', text: 'Here is the new plan: 1. read main.ts\n2. edit imports\n3. verify.' }] } },
    { type: 'tool/call', seq: 3, time: 1100, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c1' } },
    { type: 'tool/call', seq: 4, time: 1150, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c2' } },
    { type: 'tool/call', seq: 5, time: 1200, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c3' } },
    { type: 'tool/call', seq: 6, time: 1250, data: { name: 'bash', arguments: 'ls', callId: 'c4' } },
    { type: 'tool/call', seq: 7, time: 1300, data: { name: 'fs.read', arguments: '{"path":"main.ts"}', callId: 'c5' } },
    { type: 'turn/end', seq: 8, time: 1350 },
  ]
  const { all } = SD.detectSignals(events)
  // Group by signal kind (matches renderer.js applyTurnSignalChips)
  const seen = new Map()
  for (const s of all) {
    if (!seen.has(s.signal)) seen.set(s.signal, { signal: s.signal, count: 1, first: s })
    else seen.get(s.signal).count++
  }
  const chips = Array.from(seen.values()).map(e => {
    const cls = SD.classFor(e.signal)
    const label = e.count > 1 ? `${SD.labelFor(e.signal)} × ${e.count}` : SD.labelFor(e.signal)
    const title = SD.tooltipFor(e.first)
    return `<button class="turn-signal-chip ${cls}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`
  }).join('')
  const body = `
<section class="assistant-turn">
  <div class="turn-body">
    <div class="turn-signal-chip-row">${chips}</div>
    <div class="text-block">Here is the new plan: 1. read main.ts, 2. edit imports, 3. verify.</div>
    <div class="tool-row"><span class="turn-glyph">▸</span>fs.read(main.ts)</div>
    <div class="tool-row"><span class="turn-glyph">▸</span>fs.read(main.ts)</div>
    <div class="tool-row"><span class="turn-glyph">▸</span>fs.read(main.ts)</div>
    <div class="tool-row"><span class="turn-glyph">▸</span>bash(ls)</div>
    <div class="tool-row"><span class="turn-glyph">▸</span>fs.read(main.ts)</div>
  </div>
</section>`
  const html = pageWrap(
    'Signals 03 — Turn container: signal chip row',
    body,
    'The chip row sits above the assistant body. Each chip covers one signal kind detected in this turn (loop / redundant / plan-update). Clicking a chip auto-opens the trace drawer for a drill-in. Signals detected in this turn: <code>' + all.map(s => s.signal).join(', ') + '</code>.',
  )
  writeFileSync(resolve(outdir, 'signals-03-chips-plan.html'), html)
  console.log('wrote', resolve(outdir, 'signals-03-chips-plan.html'))
}
