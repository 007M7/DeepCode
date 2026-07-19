// subagent-view.js — subagent 起跑/返回卡 + 并行 rail (§1.4 fixture 1.4)
//
// One "subagent card" per subagent invocation. Head shows parent→child IDs,
// status pill, and elapsed time. Body has three collapsible sections:
//   ① prompt      — what the parent handed to the child (user/message in the
//                    child's turn 0, source={kind:'plugin', plugin:'subagent-*'})
//   ② steps       — inline step timeline (call names + durations)
//   ③ return      — the structured JSON return the parent gets back
//                    (§1.4 fixture uses code_block(lang=json) as the
//                    discriminator; wire seat for a real structured return
//                    slot is queued as)
//
// Parallel rail: when N subagents run at once we render a mini row of pills
// at the top of the parent stream so a viewer can see fan-out at a glance;
// clicking a pill scrolls the corresponding card into view.
//
// Wire status:
//   subagent.started/finished are `_notification` methods (not session events),
//   see coverage doc §1 "subagent lifecycle notifications". They ride the
//   `_notification` seam that live wire uses today via jsonrpc-net; the
//   fixture inlines them at the head/tail of the child's event array with
//   `_mock:true` so they're distinguishable from wire-driven ones.
//
// Exports:
//   parseSubagentReturn(lastAssistantMessage) → { ok, json, raw } | null
//   summariseSubagentSteps(childEvents)       → { total, running, done, failed, durationMs }
//   buildSubagentCard(doc, spec, opts)        → HTMLElement
//   buildSubagentRail(doc, agents, opts)      → HTMLElement (row of pills)
//
// buildSubagentCard spec:
//   { parentSessionId, childSessionId, status?, provider?, agentId?,
//     childEvents?: [], lastAssistantMessage?: ContentBlock[], startedAt?, finishedAt? }

'use strict';

// Strip the ```json fence used by the §1.4 fixture and any real-world
// subagent that returns JSON via code_block. Returns null if no fence.
function extractJsonFence(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

function parseSubagentReturn(lastAssistantMessage) {
  if (!Array.isArray(lastAssistantMessage)) return null;
  const parts = lastAssistantMessage
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
  if (!parts) return null;
  const fenced = extractJsonFence(parts);
  const candidate = fenced ?? parts.trim();
  try {
    const json = JSON.parse(candidate);
    return { ok: true, json, raw: candidate };
  } catch (_) {
    return { ok: false, json: null, raw: candidate };
  }
}

function summariseSubagentSteps(childEvents) {
  const bucket = { total: 0, running: 0, done: 0, failed: 0, durationMs: null };
  if (!Array.isArray(childEvents)) return bucket;
  let firstT = null;
  let lastT = null;
  const openSteps = new Set();
  for (const ev of childEvents) {
    if (!ev) continue;
    if (typeof ev.time === 'number') {
      if (firstT == null || ev.time < firstT) firstT = ev.time;
      if (lastT == null || ev.time > lastT) lastT = ev.time;
    }
    if (ev.type === 'step/start') {
      bucket.total += 1;
      openSteps.add(ev.data && ev.data.step);
    } else if (ev.type === 'step/end') {
      openSteps.delete(ev.data && ev.data.step);
      bucket.done += 1;
    } else if (ev.type === 'turn/end') {
      const reason = ev.data && ev.data.reason && ev.data.reason.kind;
      if (reason === 'error' || reason === 'failed') bucket.failed += 1;
    }
  }
  bucket.running = openSteps.size;
  if (firstT != null && lastT != null && lastT > firstT) bucket.durationMs = lastT - firstT;
  return bucket;
}

function statusPillLabel(status) {
  if (status === 'ok' || status === 'done' || status === 'completed') return 'done';
  if (status === 'running' || status === 'started') return 'running';
  if (status === 'error' || status === 'failed') return 'failed';
  return status || 'running';
}

/**
 * Compose the status token that appears in the trace summary header. When
 * the wire supplies a `stopReason` (viz-coverage-matrix §5 P0-6: it does
 * on `subagent.finished` per server.ts:114-122 but pre-fix nothing rendered
 * it), append it as ` · <stop>` — matches the "done · stop" grammar the
 * task brief specifies. Empty/absent stopReason falls back to the bare
 * status label so old fixtures keep the same output.
 *
 * @param {string} status pill-normalized status ('done'|'running'|'failed'|…)
 * @param {unknown} stopReason opaque string from the wire; other types skipped
 * @returns {string}
 */
function renderStatusToken(status, stopReason) {
  if (typeof stopReason !== 'string' || stopReason === '') return status;
  return `${status} · ${stopReason}`;
}

function subagentShortId(id) {
  if (!id) return '?';
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function subagentTextFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

function buildSubagentCard(doc, spec, opts = {}) {
  if (!doc) throw new Error('subagent-view: buildSubagentCard requires a document');
  spec = spec || {};
  const card = doc.createElement('div');
  card.className = 'subagent-card';
  card.dataset.childSessionId = spec.childSessionId || '';

  // C16/C17 (drift cycle 13/14): when this card is embedded inside a
  // buildInlineSubagentTrace shell, that shell already renders lineage +
  // status + steps + duration in its own <summary>. Rendering the same
  // fields again inside the card body produces a double-header. Callers
  // can pass `opts.omitHead: true` to suppress the redundant head strip
  // and jump straight to the body sections (prompt / steps / return).
  const omitHead = opts && opts.omitHead === true;
  if (!omitHead) {
    // Head — parent→child, provider, status, elapsed.
    const head = doc.createElement('div');
    head.className = 'subagent-card-head';
    const parents = doc.createElement('span');
    parents.className = 'subagent-card-lineage';
    parents.textContent = `${subagentShortId(spec.parentSessionId)} → ${subagentShortId(spec.childSessionId)}`;
    head.appendChild(parents);
    if (spec.provider) {
      const p = doc.createElement('span');
      p.className = 'subagent-card-provider';
      p.textContent = spec.provider;
      head.appendChild(p);
    }
    const status = statusPillLabel(spec.status);
    const pill = doc.createElement('span');
    pill.className = `subagent-card-status status-${status}`;
    // viz-coverage-matrix §5 P0-6: promote stopReason into the status pill
    // so the standalone card matches the inline summary's grammar.
    pill.textContent = renderStatusToken(status, spec.stopReason);
    head.appendChild(pill);
    const summary = summariseSubagentSteps(spec.childEvents);
    if (summary.total > 0) {
      const t = doc.createElement('span');
      t.className = 'subagent-card-steps';
      t.textContent = `${summary.done}/${summary.total} steps`;
      head.appendChild(t);
    }
    if (Number.isFinite(summary.durationMs)) {
      const d = doc.createElement('span');
      d.className = 'subagent-card-duration';
      d.textContent = summary.durationMs < 1000
        ? `${summary.durationMs}ms`
        : `${(summary.durationMs / 1000).toFixed(1)}s`;
      head.appendChild(d);
    }
    card.appendChild(head);
  }

  // Prompt section — the user/message the parent injected as the child's
  // seed. Renders as a quoted block so it's visually distinct from the
  // child's own output.
  const promptEv = Array.isArray(spec.childEvents)
    ? spec.childEvents.find(e => e && e.type === 'user/message')
    : null;
  if (promptEv && promptEv.data) {
    const sec = doc.createElement('details');
    sec.className = 'subagent-card-section subagent-card-prompt';
    sec.open = false;
    const s = doc.createElement('summary');
    s.textContent = 'prompt';
    sec.appendChild(s);
    const q = doc.createElement('blockquote');
    q.className = 'subagent-card-prompt-body';
    q.textContent = subagentTextFromBlocks(promptEv.data.content);
    sec.appendChild(q);
    card.appendChild(sec);
  }

  // Steps section — inline tool-call timeline. Compact enough that the
  // whole subagent trace stays on one screen.
  const toolCalls = Array.isArray(spec.childEvents)
    ? spec.childEvents.filter(e => e && e.type === 'tool/call')
    : [];
  if (toolCalls.length > 0) {
    const sec = doc.createElement('details');
    sec.className = 'subagent-card-section subagent-card-steps';
    sec.open = true;
    const s = doc.createElement('summary');
    s.textContent = `steps (${toolCalls.length})`;
    sec.appendChild(s);
    const list = doc.createElement('ol');
    list.className = 'subagent-card-steps-list';
    for (const tc of toolCalls) {
      const li = doc.createElement('li');
      li.className = 'subagent-card-step';
      const name = doc.createElement('code');
      name.className = 'subagent-card-step-name';
      name.textContent = (tc.data && tc.data.name) || '(tool)';
      li.appendChild(name);
      // Argument peek — first 80 chars, no fancy parsing. The point is
      // "roughly what did the subagent search for" not a full JSON view.
      const args = tc.data && tc.data.arguments;
      if (typeof args === 'string' && args.length > 0) {
        const peek = doc.createElement('span');
        peek.className = 'subagent-card-step-args';
        peek.textContent = args.length > 80 ? `${args.slice(0, 80)}…` : args;
        li.appendChild(peek);
      }
      list.appendChild(li);
    }
    sec.appendChild(list);
    card.appendChild(sec);
  }

  // Return section — three tiers (viz-coverage-matrix §5 P0-5):
  //   ① structured JSON (parses via parseSubagentReturn) — code-block preview
  //   ② prose preview from lastAssistantMessage — when no fence is present
  //      the subagent's final assistant message stands in as the return.
  //      Pre-fix this fell into ② styled as a <pre> which read as code;
  //      now it's a normal paragraph so a natural-language wrap-up looks
  //      like prose, not a raw dump.
  //   ③ nothing — no lastAssistantMessage at all, skip section entirely.
  //
  // The demo fixture uses code_block(lang=json); once the wire adds a
  // dedicated structured-return slot, this reader still works
  // because it strips the fence first.
  if (Array.isArray(spec.lastAssistantMessage) && spec.lastAssistantMessage.length > 0) {
    const ret = parseSubagentReturn(spec.lastAssistantMessage);
    const sec = doc.createElement('details');
    sec.className = 'subagent-card-section subagent-card-return';
    sec.open = true;
    const s = doc.createElement('summary');
    s.textContent = ret && ret.ok
      ? 'return (structured JSON)'
      : 'return (last assistant message)';
    sec.appendChild(s);
    if (ret && ret.ok) {
      const pre = doc.createElement('pre');
      pre.className = 'subagent-card-return-json';
      pre.textContent = JSON.stringify(ret.json, null, 2);
      sec.appendChild(pre);
    } else if (ret && ret.raw) {
      // Prose preview — a paragraph, not a code block. Long messages get
      // a length pill so a reader knows this is a truncation, not the
      // whole reply. Full text stays available in the L2 raw JSON drawer
      // (renderer.js exposes the notification payload verbatim).
      const p = doc.createElement('div');
      p.className = 'subagent-card-return-prose';
      p.textContent = ret.raw;
      sec.appendChild(p);
    } else {
      // parseSubagentReturn returned null (no text blocks at all) — surface
      // this rare state instead of showing an empty section.
      const empty = doc.createElement('div');
      empty.className = 'subagent-card-return-empty';
      empty.textContent = '(subagent returned no text — see raw payload for structured content)';
      sec.appendChild(empty);
    }
    card.appendChild(sec);
  }

  return card;
}

function buildSubagentRail(doc, agents, opts = {}) {
  if (!doc) throw new Error('subagent-view: buildSubagentRail requires a document');
  const rail = doc.createElement('div');
  rail.className = 'subagent-rail';
  if (!Array.isArray(agents) || agents.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'subagent-rail-empty';
    empty.textContent = 'no subagents running';
    rail.appendChild(empty);
    return rail;
  }
  for (const a of agents) {
    const pill = doc.createElement('button');
    pill.className = `subagent-rail-pill status-${statusPillLabel(a.status)}`;
    pill.type = 'button';
    pill.dataset.childSessionId = a.childSessionId || '';
    pill.textContent = subagentShortId(a.childSessionId);
    // viz-coverage-matrix §5 P0-5/6: rail tooltip carries stopReason plus
    // the lastAssistantMessage one-liner so a hover over a sealed pill
    // shows what the child said before the parent had to click through.
    pill.title = buildRailPillTooltip(a);
    if (typeof opts.onPillClick === 'function') {
      pill.addEventListener('click', () => opts.onPillClick(a.childSessionId, a));
    }
    rail.appendChild(pill);
  }
  return rail;
}

/**
 * Compose the `title=` string for a rail pill. Shape:
 *   "<childId>\n<status[ · <stopReason>]>\n[preview…]"
 * Empty parts collapse — a running pill with no lastAssistantMessage yet
 * just shows "<childId>\nrunning".
 */
function buildRailPillTooltip(a) {
  const lines = [];
  lines.push(a.childSessionId || '(no id)');
  lines.push(renderStatusToken(statusPillLabel(a.status), a.stopReason));
  const preview = subagentLastMessagePreview(a.lastAssistantMessage);
  if (preview) lines.push(preview);
  return lines.join('\n');
}

/**
 * Flatten a ContentBlock[] or string to a single-line preview, capped at
 * ~140 chars so the tooltip doesn't wrap into a modal. Used by the rail
 * pill tooltip; also handy for the sidebar row hover.
 */
function subagentLastMessagePreview(lastAssistantMessage) {
  const text = typeof lastAssistantMessage === 'string'
    ? lastAssistantMessage
    : subagentTextFromBlocks(lastAssistantMessage);
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 140 ? `${collapsed.slice(0, 137)}…` : collapsed;
}

// --- Inline subagent trace (#162) -----------------------------------
//
// Wraps buildSubagentCard in an inline shell that sits directly under the
// parent's spawn tool-row inside the assistant-turn body (turn-child role).
// Header row echoes the R2 glyph/name shape from assistant-turn so a reader
// sees the subagent as a peer step, not a floating side card.
//
// The card body is collapsed by default (opts.collapsed !== false). When
// spec.childEvents is present the card already renders lineage + steps +
// return. When it's absent (subagent.started fired but no child events yet
// — the deferred live-broadcast path in §8.2), only the head row shows.
function buildInlineSubagentTrace(doc, spec, opts = {}) {
  if (!doc) throw new Error('subagent-view: buildInlineSubagentTrace requires a document');
  spec = spec || {};
  const wrap = doc.createElement('details');
  wrap.className = 'turn-child subagent-trace';
  wrap.dataset.parentCallId = spec.parentCallId || '';
  wrap.dataset.childSessionId = spec.childSessionId || '';
  wrap.open = opts.collapsed === false;

  const head = doc.createElement('summary');
  head.className = 'subagent-trace-summary';
  const glyph = doc.createElement('span');
  glyph.className = 'turn-glyph subagent-trace-glyph';
  const status = statusPillLabel(spec.status);
  // R2: glyph column uses ✓/✗ on sealed, ▸ while running. subagent traces
  // are always sealed by the time we render them (defer live per §8.2).
  glyph.textContent = status === 'failed' ? '✗' : (status === 'running' ? '▸' : '✓');
  const label = doc.createElement('span');
  label.className = 'subagent-trace-label';
  label.textContent = 'subagent';
  const lineage = doc.createElement('span');
  lineage.className = 'subagent-trace-lineage';
  lineage.textContent = subagentShortId(spec.childSessionId);
  const stepsSummary = summariseSubagentSteps(spec.childEvents);
  const parts = [];
  if (stepsSummary.total > 0) parts.push(`${stepsSummary.done}/${stepsSummary.total} steps`);
  if (Number.isFinite(stepsSummary.durationMs)) {
    parts.push(stepsSummary.durationMs < 1000
      ? `${stepsSummary.durationMs}ms`
      : `${(stepsSummary.durationMs / 1000).toFixed(1)}s`);
  }
  // viz-coverage-matrix §5 P0-6: append stopReason to the status segment
  // so a reader sees "done · stop" / "done · max-tokens" / "failed · error"
  // at a glance instead of just "done". Wire ships stopReason on
  // subagent.finished (server.ts:114-122); pre-fix it landed on meta only
  // and never surfaced. `renderStatusToken(status, stopReason)` keeps a
  // sensible label when stopReason is null (falls back to the bare status).
  parts.push(renderStatusToken(status, spec.stopReason));
  const meta = doc.createElement('span');
  meta.className = 'subagent-trace-meta';
  meta.textContent = parts.join(' · ');
  head.append(glyph, label, lineage, meta);
  wrap.appendChild(head);

  // Body — full card reused, wrapped in a container that indents to sit
  // under the summary row. C16/C17 (drift cycle 13/14): omitHead=true so
  // the inner card doesn't re-render lineage/status/steps/duration that
  // the outer <summary> already shows — one header strip per subagent.
  const body = doc.createElement('div');
  body.className = 'subagent-trace-body';
  const card = buildSubagentCard(doc, spec, { ...opts, omitHead: true });
  body.appendChild(card);

  // lane-ctx-deep F4: drill-down tabs (Tool defs / Inbound query). Appended
  // after the card sections so a reader sees the "how the child was
  // instrumented" summary at the foot of the subagent trace. Skipped when
  // the drilldown module isn't loaded (test harness stubs the shell out).
  appendSubagentDrilldownTabs(doc, body, spec);

  wrap.appendChild(body);

  return wrap;
}

/**
 * Render two tabs — "Tool defs" and "Inbound query" — using the pure
 * `buildSubagentDrilldown` view model. Exposed for tests via the module
 * exports so a headless assertion can build the tabs without wrapping the
 * whole inline trace.
 */
function appendSubagentDrilldownTabs(doc, parent, spec) {
  const api = (typeof window !== 'undefined' && window.__dshSubagentDrilldown)
    || (typeof require === 'function' ? tryRequireDrilldown() : null);
  if (!api || typeof api.buildSubagentDrilldown !== 'function') return;
  const view = api.buildSubagentDrilldown(spec || {});

  // Skip if we have nothing at all to show — an empty view would just add
  // dead chrome to the subagent card.
  if (view.toolDefsSource === 'empty' && view.inboundQuery.source === 'empty') return;

  const wrap = doc.createElement('div');
  wrap.className = 'subagent-drilldown';
  const strip = doc.createElement('div');
  strip.className = 'subagent-drilldown-tabstrip';
  strip.setAttribute('role', 'tablist');

  const tabs = [
    { id: 'tooldefs', label: `Tool defs (${view.toolDefs.length})` },
    { id: 'inbound',  label: 'Inbound query' },
  ];
  const bodies = {};
  const buttons = {};
  for (const t of tabs) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'subagent-drilldown-tab';
    btn.textContent = t.label;
    btn.setAttribute('role', 'tab');
    btn.dataset.tab = t.id;
    const isActive = t.id === 'tooldefs';
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.tabIndex = isActive ? 0 : -1;
    strip.appendChild(btn);
    buttons[t.id] = btn;
    const body = doc.createElement('div');
    body.className = 'subagent-drilldown-panel';
    body.setAttribute('role', 'tabpanel');
    body.hidden = !isActive;
    bodies[t.id] = body;
  }

  // Tool defs panel — list one row per tool. Marks whether the list was
  // explicitly reported or inferred from tool/call names so a reader knows
  // whether they're seeing "what the child could do" vs "what it happened
  // to reach for".
  const tdBody = bodies.tooldefs;
  const tdHead = doc.createElement('div');
  tdHead.className = 'subagent-drilldown-head muted small';
  tdHead.textContent = view.toolDefsSource === 'explicit'
    ? `${view.toolDefs.length} tool${view.toolDefs.length === 1 ? '' : 's'} available at start`
    : view.toolDefsSource === 'inferred'
    ? `${view.toolDefs.length} tool${view.toolDefs.length === 1 ? '' : 's'} observed (inferred from tool/call events)`
    : 'no tool activity recorded';
  tdBody.appendChild(tdHead);
  if (view.toolDefs.length > 0) {
    const list = doc.createElement('ul');
    list.className = 'subagent-drilldown-toollist';
    for (const t of view.toolDefs) {
      const li = doc.createElement('li');
      li.className = 'subagent-drilldown-toolrow';
      const name = doc.createElement('code');
      name.className = 'subagent-drilldown-toolname';
      name.textContent = t.name;
      li.appendChild(name);
      if (t.sampleArgs) {
        const args = doc.createElement('span');
        args.className = 'subagent-drilldown-toolargs muted small';
        args.textContent = t.sampleArgs;
        li.appendChild(args);
      }
      if (t.firstSeq) {
        const seq = doc.createElement('span');
        seq.className = 'subagent-drilldown-toolseq muted small';
        seq.textContent = `seq ${t.firstSeq}`;
        li.appendChild(seq);
      }
      list.appendChild(li);
    }
    tdBody.appendChild(list);
  }

  // Inbound query panel — verbatim seed prompt text, plus a hint chip
  // stating where it came from (explicit spec vs. seed-event mining).
  const inb = bodies.inbound;
  const inbHead = doc.createElement('div');
  inbHead.className = 'subagent-drilldown-head muted small';
  inbHead.textContent = view.inboundQuery.source === 'explicit'
    ? 'From parent invocation (explicit)'
    : view.inboundQuery.source === 'seed-event'
    ? `From child seed user/message${view.inboundQuery.seq ? ` at seq ${view.inboundQuery.seq}` : ''}`
    : 'No inbound query recorded';
  inb.appendChild(inbHead);
  if (view.inboundQuery.text) {
    const q = doc.createElement('blockquote');
    q.className = 'subagent-drilldown-query';
    q.textContent = view.inboundQuery.text;
    inb.appendChild(q);
  }

  const activate = (id) => {
    for (const t of tabs) {
      const on = t.id === id;
      buttons[t.id].setAttribute('aria-selected', on ? 'true' : 'false');
      buttons[t.id].tabIndex = on ? 0 : -1;
      bodies[t.id].hidden = !on;
    }
  };
  strip.addEventListener('click', (ev) => {
    const target = ev && ev.target;
    if (!target) return;
    const id = target === buttons.tooldefs ? 'tooldefs' : target === buttons.inbound ? 'inbound' : null;
    if (id) activate(id);
  });

  wrap.appendChild(strip);
  wrap.appendChild(bodies.tooldefs);
  wrap.appendChild(bodies.inbound);
  parent.appendChild(wrap);
}

function tryRequireDrilldown() {
  try { return require('./subagent-drilldown.js'); } catch (_) { return null; }
}

// Local name is prefixed to avoid the load-time `const api` collision
// with sibling non-IIFE renderer modules (test/renderer-collisions.test.js
// keeps a static gate).
const subagentViewApi = {
  parseSubagentReturn,
  summariseSubagentSteps,
  buildSubagentCard,
  buildSubagentRail,
  buildInlineSubagentTrace,
  renderStatusToken,
  subagentLastMessagePreview,
  appendSubagentDrilldownTabs,
};
if (typeof module !== 'undefined' && module.exports) module.exports = subagentViewApi;
if (typeof window !== 'undefined') window.__dshSubagentView = subagentViewApi;
