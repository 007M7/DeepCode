// workflow-view.js — Dynamic Workflow 五族卡片 (§1.6 fixtures 1.6-*)
//
// Pure DOM builder for the five workflow shapes surfaced in the strategy doc:
//   seq     — linear stepper                (fixtures/1.6-workflow-seq.json)
//   fan-out — root + parallel arms          (fixtures/1.6-workflow-fanout.json)
//   dag     — mini directed graph           (fixtures/1.6-workflow-dag.json)
//   iter    — loop iterations              (fixtures/1.6-workflow-iter.json)
//   branch  — decision tree (diag→branch)   (fixtures/1.6-workflow-branch.json)
//
// Also owns the replay bar (回放条) that lets a viewer scrub the "current step"
// pointer for demo purposes without waiting for wire events.
//
// Why not one flat list? Boss note #4 (2026-07-16): workflow + compaction +
// context rail must feel like the same canvas. Callers render workflow cards
// into `.context-rail-drawer`'s body when the drawer is used as a full-workflow
// viewer, or inline in the stream when they arrive as tool-result cards.
// The DOM produced here is container-agnostic; the caller decides where it
// lands.
//
// The workflow/* Cordis events NOW cross the JSON-RPC wire as `workflow.event`
// notifications (runtime commit dd29d8631, integration/desktop-demo). Two feed
// paths land in this module:
//   - LIVE: renderer.js subscribes to the `workflow.event` notification, folds
//     the incremental frames through workflow-live-model.js into an aggregate
//     {name, kind:'seq', steps[]} object, and passes it with `{ isLive:true }`.
//     Live cards wear a small "live · workflow.event" chip. On profiles/runtimes
//     that never mount ctx.workflows the notification simply never fires, so
//     nothing renders — no chip, no error.
//   - MOCK: the Debug popover still mints fixture cards (each fixture carries
//     `_mock:true`) with `{ isMock:true }`; those keep the "mock · workflow/*
//     not on wire yet" chip so a reader can tell demo pixels from real ones.
//
// Exports:
//   classifyWorkflowKind(kind)      → 'seq'|'fan-out'|'dag'|'iter'|'branch'|'unknown'
//   summariseWorkflowProgress(wf)   → { total, done, running, pending, failed }
//   buildWorkflowCard(doc, wf, opts)→ HTMLElement
//
// buildWorkflowCard opts:
//   isMock?: boolean               — show the "mock · not on wire" chip
//   isLive?: boolean               — show the "live · workflow.event" chip
//                                    (mutually exclusive with isMock)
//   activeStepId?: string          — highlight the current step (replay pointer)
//   onStepClick?(stepId, wf)       — click handler for a step node
//   showReplayBar?: boolean        — mount replay bar with prev/next buttons

'use strict';

const WORKFLOW_KINDS = new Set(['seq', 'fan-out', 'dag', 'iter', 'branch']);

function classifyWorkflowKind(kind) {
  if (typeof kind !== 'string') return 'unknown';
  const k = kind.trim().toLowerCase();
  if (k === 'fanout') return 'fan-out';
  return WORKFLOW_KINDS.has(k) ? k : 'unknown';
}

function summariseWorkflowProgress(wf) {
  const bucket = { total: 0, done: 0, running: 0, pending: 0, failed: 0 };
  if (!wf) return bucket;
  const items = wf.kind === 'iter'
    ? (wf.loop && Array.isArray(wf.loop.iterations) ? wf.loop.iterations : [])
    : (Array.isArray(wf.steps) ? wf.steps : []);
  for (const it of items) {
    bucket.total += 1;
    const s = it && it.status;
    if (s === 'done') bucket.done += 1;
    else if (s === 'running') bucket.running += 1;
    else if (s === 'failed' || s === 'error') bucket.failed += 1;
    else bucket.pending += 1;
  }
  return bucket;
}

function statusGlyph(status) {
  if (status === 'done') return '✓';
  if (status === 'running') return '⋯';
  if (status === 'failed' || status === 'error') return '✗';
  return '·';
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Body renderers — one per kind. Each returns the body element (not
// wrapped in a card), and the wrapper is built by buildWorkflowCard.

function bodyForSeq(doc, wf, opts) {
  const list = doc.createElement('ol');
  list.className = 'workflow-body workflow-body-seq';
  for (const step of wf.steps || []) {
    const li = doc.createElement('li');
    li.className = `workflow-step status-${step.status || 'pending'}`;
    li.dataset.stepId = step.id || '';
    if (opts.activeStepId && step.id === opts.activeStepId) li.classList.add('is-active');
    const glyph = doc.createElement('span');
    glyph.className = 'workflow-step-glyph';
    glyph.textContent = statusGlyph(step.status);
    const label = doc.createElement('span');
    label.className = 'workflow-step-label';
    label.textContent = step.name || step.id || '(step)';
    const meta = doc.createElement('span');
    meta.className = 'workflow-step-meta';
    const bits = [];
    if (Number.isFinite(step.durationMs)) bits.push(fmtDuration(step.durationMs));
    if (step.output) bits.push(step.output);
    meta.textContent = bits.join(' · ');
    li.append(glyph, label, meta);
    if (typeof opts.onStepClick === 'function') {
      li.addEventListener('click', () => opts.onStepClick(step.id, wf));
      li.classList.add('is-clickable');
    }
    list.appendChild(li);
  }
  return list;
}

function bodyForFanout(doc, wf, opts) {
  const wrap = doc.createElement('div');
  wrap.className = 'workflow-body workflow-body-fanout';
  const steps = wf.steps || [];
  const root = steps.find(s => Array.isArray(s.out) && s.out.length > 0 && (!s.in || s.in.length === 0)) || steps[0];
  if (root) {
    const rootEl = doc.createElement('div');
    rootEl.className = `workflow-fanout-root status-${root.status || 'pending'}`;
    rootEl.textContent = `${statusGlyph(root.status)} ${root.name || root.id}`;
    wrap.appendChild(rootEl);
  }
  const arms = doc.createElement('div');
  arms.className = 'workflow-fanout-arms';
  for (const s of steps) {
    if (root && s === root) continue;
    const arm = doc.createElement('div');
    arm.className = `workflow-fanout-arm status-${s.status || 'pending'}`;
    arm.dataset.stepId = s.id || '';
    if (opts.activeStepId && s.id === opts.activeStepId) arm.classList.add('is-active');
    const g = doc.createElement('span');
    g.className = 'workflow-step-glyph';
    g.textContent = statusGlyph(s.status);
    const lbl = doc.createElement('span');
    lbl.className = 'workflow-step-label';
    lbl.textContent = s.name || s.id;
    const dur = doc.createElement('span');
    dur.className = 'workflow-step-meta';
    dur.textContent = Number.isFinite(s.durationMs) ? fmtDuration(s.durationMs) : '';
    arm.append(g, lbl, dur);
    if (typeof opts.onStepClick === 'function') {
      arm.addEventListener('click', () => opts.onStepClick(s.id, wf));
      arm.classList.add('is-clickable');
    }
    arms.appendChild(arm);
  }
  wrap.appendChild(arms);
  return wrap;
}

// DAG mini-map: layered, in→out adjacency lists. This is intentionally
// simple — the layout is level-based (BFS from in-degree=0 nodes), no
// real force-directed graph. Enough to see fan-in / fan-out shape at a
// glance. Complex DAGs get a "graph truncated" affordance so we don't
// try to squeeze a 30-node graph into a 320px drawer.
function bodyForDag(doc, wf, opts) {
  const wrap = doc.createElement('div');
  wrap.className = 'workflow-body workflow-body-dag';
  const steps = wf.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // Compute level: node level = max(level(in)) + 1, roots = level 0.
  const level = new Map();
  const roots = steps.filter(s => !s.in || s.in.length === 0);
  const queue = roots.map(r => (level.set(r.id, 0), r));
  while (queue.length) {
    const n = queue.shift();
    const l = level.get(n.id);
    for (const outId of (n.out || [])) {
      const cur = level.get(outId);
      if (cur === undefined || cur < l + 1) {
        level.set(outId, l + 1);
        const next = byId.get(outId);
        if (next) queue.push(next);
      }
    }
  }
  const maxLevel = Math.max(0, ...Array.from(level.values()));
  const layers = Array.from({ length: maxLevel + 1 }, () => []);
  for (const s of steps) {
    const l = level.get(s.id) ?? 0;
    layers[l].push(s);
  }
  for (const lvl of layers) {
    const row = doc.createElement('div');
    row.className = 'workflow-dag-layer';
    for (const s of lvl) {
      const node = doc.createElement('div');
      node.className = `workflow-dag-node status-${s.status || 'pending'}`;
      node.dataset.stepId = s.id;
      if (opts.activeStepId && s.id === opts.activeStepId) node.classList.add('is-active');
      const g = doc.createElement('span');
      g.className = 'workflow-step-glyph';
      g.textContent = statusGlyph(s.status);
      const lbl = doc.createElement('span');
      lbl.className = 'workflow-step-label';
      lbl.textContent = s.name || s.id;
      node.append(g, lbl);
      if (typeof opts.onStepClick === 'function') {
        node.addEventListener('click', () => opts.onStepClick(s.id, wf));
        node.classList.add('is-clickable');
      }
      row.appendChild(node);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function bodyForIter(doc, wf, opts) {
  const wrap = doc.createElement('div');
  wrap.className = 'workflow-body workflow-body-iter';
  const loop = wf.loop || {};
  if (loop.predicate) {
    const p = doc.createElement('div');
    p.className = 'workflow-iter-predicate';
    p.textContent = `while (${loop.predicate})`;
    wrap.appendChild(p);
  }
  const list = doc.createElement('ol');
  list.className = 'workflow-iter-iters';
  for (const it of (loop.iterations || [])) {
    const li = doc.createElement('li');
    li.className = `workflow-step status-${it.status || 'pending'}`;
    li.dataset.stepId = `iter:${it.n}`;
    if (opts.activeStepId === `iter:${it.n}`) li.classList.add('is-active');
    const g = doc.createElement('span');
    g.className = 'workflow-step-glyph';
    g.textContent = statusGlyph(it.status);
    const lbl = doc.createElement('span');
    lbl.className = 'workflow-step-label';
    lbl.textContent = `[${it.n}] ${it.item || ''}`;
    const meta = doc.createElement('span');
    meta.className = 'workflow-step-meta';
    const bits = [];
    if (Number.isFinite(it.durationMs)) bits.push(fmtDuration(it.durationMs));
    if (it.output) bits.push(it.output);
    meta.textContent = bits.join(' · ');
    li.append(g, lbl, meta);
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function bodyForBranch(doc, wf, opts) {
  const wrap = doc.createElement('div');
  wrap.className = 'workflow-body workflow-body-branch';
  for (const step of (wf.steps || [])) {
    const li = doc.createElement('div');
    li.className = `workflow-branch-step status-${step.status || 'pending'}`;
    if (step.branchLabel) li.dataset.branchLabel = step.branchLabel;
    const head = doc.createElement('div');
    head.className = 'workflow-branch-head';
    const g = doc.createElement('span');
    g.className = 'workflow-step-glyph';
    g.textContent = statusGlyph(step.status);
    const lbl = doc.createElement('span');
    lbl.className = 'workflow-step-label';
    lbl.textContent = step.name || step.id;
    head.append(g, lbl);
    if (step.branchLabel) {
      const tag = doc.createElement('span');
      tag.className = 'workflow-branch-tag';
      tag.textContent = step.branchLabel;
      head.appendChild(tag);
    }
    li.appendChild(head);
    if (step.output) {
      const out = doc.createElement('div');
      out.className = 'workflow-branch-output';
      out.textContent = step.output;
      li.appendChild(out);
    }
    wrap.appendChild(li);
  }
  return wrap;
}

const BODY_BUILDERS = {
  seq: bodyForSeq,
  'fan-out': bodyForFanout,
  dag: bodyForDag,
  iter: bodyForIter,
  branch: bodyForBranch,
};

function buildReplayBar(doc, wf, opts) {
  const items = wf.kind === 'iter'
    ? (wf.loop && wf.loop.iterations ? wf.loop.iterations.map(it => ({ id: `iter:${it.n}`, name: `[${it.n}]` })) : [])
    : (Array.isArray(wf.steps) ? wf.steps.map(s => ({ id: s.id, name: s.name || s.id })) : []);
  const bar = doc.createElement('div');
  bar.className = 'workflow-replay-bar';
  const prev = doc.createElement('button');
  prev.className = 'workflow-replay-btn ghost small';
  prev.type = 'button';
  prev.textContent = '◀ prev';
  const posLabel = doc.createElement('span');
  posLabel.className = 'workflow-replay-pos';
  const next = doc.createElement('button');
  next.className = 'workflow-replay-btn ghost small';
  next.type = 'button';
  next.textContent = 'next ▶';
  bar.append(prev, posLabel, next);

  // Cursor state is DOM-local: index into items[]. Falls back to the
  // running step, then step 0. Advancing past end/start clamps.
  let idx = items.findIndex(it => it.id === opts.activeStepId);
  if (idx < 0) {
    const runningIdx = (wf.kind === 'iter' ? wf.loop && wf.loop.iterations : wf.steps || [])
      .findIndex(it => it && it.status === 'running');
    idx = runningIdx >= 0 ? runningIdx : 0;
  }
  const refresh = () => {
    posLabel.textContent = items.length ? `${idx + 1} / ${items.length} · ${items[idx].name}` : '(empty)';
    prev.disabled = idx <= 0;
    next.disabled = idx >= items.length - 1;
  };
  prev.addEventListener('click', () => {
    if (idx > 0) { idx -= 1; refresh(); opts.onReplayMove && opts.onReplayMove(items[idx].id, wf); }
  });
  next.addEventListener('click', () => {
    if (idx < items.length - 1) { idx += 1; refresh(); opts.onReplayMove && opts.onReplayMove(items[idx].id, wf); }
  });
  refresh();
  return bar;
}

function buildWorkflowCard(doc, wf, opts = {}) {
  if (!doc) throw new Error('workflow-view: buildWorkflowCard requires a document');
  const kind = classifyWorkflowKind(wf && wf.kind);
  const card = doc.createElement('div');
  card.className = `workflow-card workflow-card-${kind}`;
  card.dataset.kind = kind;

  // Head: title + kind tag + progress summary + mock chip (if applicable).
  const head = doc.createElement('div');
  head.className = 'workflow-card-head';
  const title = doc.createElement('span');
  title.className = 'workflow-card-title';
  title.textContent = (wf && wf.name) ? `workflow: ${wf.name}` : 'workflow';
  head.appendChild(title);
  const kindTag = doc.createElement('span');
  kindTag.className = `workflow-card-kind workflow-card-kind--${kind}`;
  kindTag.textContent = kind;
  head.appendChild(kindTag);
  const prog = summariseWorkflowProgress(wf);
  if (prog.total > 0) {
    const p = doc.createElement('span');
    p.className = 'workflow-card-progress';
    p.textContent = `${prog.done}/${prog.total} · ${prog.running} running`;
    head.appendChild(p);
  }
  if (opts.isMock) {
    const chip = doc.createElement('span');
    chip.className = 'workflow-card-chip workflow-card-chip--mock';
    chip.textContent = 'mock · workflow/* not on wire yet';
    chip.title = 'This card is fixture-driven (Debug popover) to demo the shape — not a live run.';
    head.appendChild(chip);
  } else if (opts.isLive) {
    // Live cards are fed off the on-wire `workflow.event` notification via
    // workflow-live-model.js. The chip is the honest counterpart to the mock
    // chip — no "not on wire" caveat, and it never appears on fixture cards.
    const chip = doc.createElement('span');
    chip.className = 'workflow-card-chip workflow-card-chip--live';
    chip.textContent = 'live · workflow.event';
    chip.title = 'Fed from the runtime\'s workflow.event notifications (workflow/* Cordis events bridged onto the JSON-RPC wire).';
    head.appendChild(chip);
  }
  card.appendChild(head);

  // Body — dispatch by kind. Unknown kinds show a diagnostic note so a
  // reviewer sees "we got the object but don't know how to draw it" rather
  // than an empty card.
  const builder = BODY_BUILDERS[kind];
  if (builder) {
    card.appendChild(builder(doc, wf, opts));
  } else {
    const note = doc.createElement('div');
    note.className = 'workflow-body workflow-body-empty';
    note.textContent = `unknown workflow kind: ${wf && wf.kind}`;
    card.appendChild(note);
  }

  // Optional replay bar — mounted after body so the pointer sits directly
  // under the steps it controls. Skipped when there's nothing to step.
  if (opts.showReplayBar && prog.total > 0) {
    card.appendChild(buildReplayBar(doc, wf, opts));
  }

  return card;
}

// Dual export — module.exports for node --test, window for renderer.
// Local name is prefixed to avoid the load-time `const api` collision
// with sibling non-IIFE renderer modules (test/renderer-collisions.test.js
// keeps a static gate).
const workflowViewApi = { classifyWorkflowKind, summariseWorkflowProgress, buildWorkflowCard };
if (typeof module !== 'undefined' && module.exports) module.exports = workflowViewApi;
if (typeof window !== 'undefined') window.__dshWorkflowView = workflowViewApi;
