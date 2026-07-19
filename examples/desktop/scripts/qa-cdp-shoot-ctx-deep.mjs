// Shots for lane-ctx-deep (task #51) — four Context-page enhancements.
// Each shot loads a QA fixture, forces a re-render, then captures the
// visible chrome for that feature. Real-machine isolated per team-lead:
// DSH_QA=1 + DSH_DESKTOP_HOME under /tmp/dsh-qa-ctx-deep so nothing here
// touches the user's live session store.
//
// Shots produced (docs/demo-shots/):
//   ctx-deep-01-window-bar.png     — Context page top strip, window
//                                     occupancy stacked bar + legend.
//   ctx-deep-02-intervention.png   — Context page top strip, intervention
//                                     markers axis.
//   ctx-deep-03-compact-config.png — Compact card on Chat tab with the
//                                     new "Config" tab active.
//   ctx-deep-04-subagent.png       — Subagent card with drill-down tabs
//                                     (Tool defs / Inbound query).

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const port = process.argv[2] || '9241'
const outdir = process.argv[3] || 'docs/demo-shots'
mkdirSync(outdir, { recursive: true })

async function main () {
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json()
  const target = targets.find((t) => t.type === 'page')
  if (!target) throw new Error('no page target on port ' + port)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = (e) => x(e) })

  let id = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    if (msg.id != null && pending.has(msg.id)) {
      const [ok, err] = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) err(new Error(msg.error.message))
      else ok(msg.result)
    }
  }
  const call = (m, p = {}, timeoutMs = 20000) => new Promise((ok, err) => {
    const _id = id++
    const timer = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(timer); ok(v) }, (e) => { clearTimeout(timer); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  const evj = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: `(async()=>{try{return (${expr})}catch(e){return {__err: String(e)}}})()`,
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const shoot = async (name) => {
    const shot = await call('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1440, height: 900, scale: 2 },
    }, 30000)
    const out = resolve(outdir, name)
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log(out)
  }

  await call('Page.enable')
  await evj(`window.dshQa && window.dshQa.revealWindow ? await window.dshQa.revealWindow() : null`)
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })
  // Dismiss onboarding.
  await evj(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const skip = btns.find(b => /skip and use defaults/i.test(b.textContent || ''));
    if (skip) { skip.click(); }
    return 'ok';
  })()`)
  await wait(300)
  // Hide devtools drawer.
  await evj(`(function(){
    const d = document.querySelector('.devtools-drawer');
    if (d) d.style.display = 'none';
    return 'ok';
  })()`)

  // Fabricate a session directly in renderer state — bypasses the need for
  // a live runtime, which the desktop demo doesn't need for these shots.
  // We manufacture a plausible cachedEvents array covering all five window
  // families + all three intervention kinds + a compact event, then expose
  // it via a temporary __dshChat.getEventsForActive() override so the
  // Context page reads the same shape production would.
  await evj(`(function(){
    const now = Date.now()
    const events = []
    let seq = 1
    function push(ev){ ev.seq = seq++; ev.time = now + seq*10; events.push(ev) }
    // system prompt seed
    push({ type: 'context/message', data: { content: [{type:'text', text: 'You are DSH, an autonomous agent operating in a research environment. Use the tools carefully.'}], source: { kind: 'system' } } })
    // tool calls (drive the tool_defs slice)
    push({ type: 'tool/call', data: { name: 'read_file', arguments: '{"path":"a.md"}' } })
    push({ type: 'tool/call', data: { name: 'search', arguments: '{"q":"context ledger"}' } })
    // user
    push({ type: 'user/message', data: { content: [{type:'text', text: 'Show me the ledger'}] } })
    // reasoning
    push({ type: 'assistant/reasoning', data: { content: [{type:'text', text: 'The user wants a ledger view. Let me project turns.'}] } })
    // assistant
    push({ type: 'assistant/message', data: { content: [{type:'text', text: 'Here is the per-turn ledger with injects and compacts.'}], usage: { inputTokens: 8000, outputTokens: 320, thinking: 180 } } })
    // steer intervention
    push({ type: 'steering/message', data: { content: [{type:'text', text: 'Actually skip the recall section.'}] } })
    // plugin inject
    push({ type: 'context/message', data: { content: [{type:'text', text: 'time-context: 09:34 UTC'}], source: { kind: 'plugin', plugin: 'time-context' } } })
    push({ type: 'context/message', data: { content: [{type:'text', text: 'guard hint fired'}], source: { kind: 'plugin', plugin: 'guard' } } })
    // turn end
    push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    // edit-rerun intervention on the next turn
    push({ type: 'user/message', data: { content: [{type:'text', text: 'Show me the ledger and expand turn 1'}], editRerun: { origSeq: 4, reason: 'clarify intent' } } })
    push({ type: 'assistant/reasoning', data: { content: [{type:'text', text: 'Re-running with expanded turn 1.'}] } })
    push({ type: 'assistant/message', data: { content: [{type:'text', text: 'Sure. Turn 1 details attached.'}], usage: { inputTokens: 8500, outputTokens: 250, thinking: 90 } } })
    push({ type: 'compact/summary', data: { summary: [{type:'text', text: 'Turn 1 summary retained.'}], model: 'deepseek-chat', maxTokens: 512, shadowedTokenCount: 6400, shadowedRange: {start:1, end:8} } })
    push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    // fork intervention
    push({ type: 'session/forked', data: { parentSeq: 14 } })
    push({ type: 'context/message', data: { content: [{type:'text', text: 'assistant reloaded'}], source: { kind: 'system' } } })
    push({ type: 'user/message', data: { content: [{type:'text', text: 'What happened in the fork?'}] } })
    push({ type: 'assistant/message', data: { content: [{type:'text', text: 'The fork branched at seq 14.'}], usage: { inputTokens: 2100, outputTokens: 90 } } })
    push({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })

    // Install override for the Context page's read path.
    const sid = 'ctx-deep-demo-session'
    const chat = window.__dshChat = window.__dshChat || {}
    const oldGetActive = chat.getActiveSessionId
    const oldGetEvents = chat.getEventsForActive
    chat.getActiveSessionId = () => sid
    chat.getEventsForActive = () => events
    chat.getSessions = () => [{ id: sid, title: 'ctx-deep demo', running: false }]
    window.__ctxDeepDemoEvents = events
    return { sid, count: events.length }
  })()`)
  await wait(700)

  // -- SHOT 1 + 2: Context page top strip (window bar + intervention) ------
  await evj(`(function(){
    if (window.__dshTabs && window.__dshTabs.switchTo) { window.__dshTabs.switchTo('context'); }
    return 'switched';
  })()`)
  await wait(500)
  await evj(`window.__dshContextPage && window.__dshContextPage.refresh && window.__dshContextPage.refresh()`)
  await wait(300)

  const layout = await evj(`(function(){
    const strip = document.querySelector('[data-context-topstrip]');
    const bar = document.getElementById('context-window-bar-track');
    const iv = document.getElementById('context-intervention-track');
    const pane = document.querySelector('.pane[data-pane="context"]');
    const chat = window.__dshChat;
    return {
      paneHidden: pane ? pane.hidden : 'NO-PANE',
      paneHtmlLen: pane ? pane.innerHTML.length : 0,
      paneChildren: pane ? Array.from(pane.children).map(c => c.tagName+':'+(c.className||c.id||'')) : null,
      documentTitle: document.title,
      windowLocation: String(window.location),
      chatKeys: chat ? Object.keys(chat) : null,
      chatGetEvents: chat && typeof chat.getEventsForActive === 'function',
      chatGetSid: chat && typeof chat.getActiveSessionId === 'function' ? chat.getActiveSessionId() : null,
      eventsLen: chat && chat.getEventsForActive ? chat.getEventsForActive().length : -1,
      stripFound: !!strip,
      stripHidden: strip ? strip.hidden : null,
      segCount: bar ? bar.children.length : 0,
      markerCount: iv ? iv.querySelectorAll('.context-intervention-marker').length : 0,
      summary: (document.getElementById('context-window-bar-summary')||{}).textContent||'',
    };
  })()`)
  console.error('ctx-deep layout ->', JSON.stringify(layout))

  await shoot('ctx-deep-01-window-bar.png')

  // Highlight the intervention strip: scroll to it if needed and take shot.
  await evj(`(function(){
    const strip = document.querySelector('.context-intervention-strip');
    if (strip && strip.scrollIntoView) strip.scrollIntoView({ block: 'start', behavior: 'auto' });
    return 'scrolled';
  })()`)
  await wait(300)
  await shoot('ctx-deep-02-intervention.png')

  // -- SHOT 3: Compact card Config tab -------------------------------------
  // We render the compact card by direct DOM injection into the chat stream:
  // the compact/summary event we seeded already flows through onSessionEvent
  // path in real prod, but here we don't have a live session so we build a
  // standalone compact card via __dshCompactCard.mountTabs.
  await evj(`(function(){
    if (window.__dshTabs && window.__dshTabs.switchTo) window.__dshTabs.switchTo('chat');
    const panes = document.querySelectorAll('.pane[data-pane]');
    for (const p of panes) p.hidden = (p.getAttribute('data-pane') !== 'chat');
    const rail = document.getElementById('context-rail'); if (rail) rail.hidden = true;
    const drawer = document.querySelector('.devtools-drawer'); if (drawer) drawer.style.display = 'none';
    for (const sel of ['.onboarding','.mock-cards-menu','.dropdown-open','[data-mock-cards]']) {
      for (const n of document.querySelectorAll(sel)) n.style.display = 'none';
    }
    return 'chat';
  })()`)
  await wait(400)
  const compactMount = await evj(`(function(){
    // Build a full-page overlay to keep the shot focused on the card.
    const prevOverlay = document.getElementById('ctx-deep-demo-overlay');
    if (prevOverlay) prevOverlay.remove();
    const prev = document.getElementById('ctx-deep-demo-compact-card');
    if (prev) prev.remove();
    const overlay = document.createElement('div');
    overlay.id = 'ctx-deep-demo-overlay';
    overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:var(--bg,#fff);z-index:9999;padding:48px 96px;overflow:auto;font-family:inherit;';
    const heading = document.createElement('h1');
    heading.style.cssText = 'font-size:24px;margin:0 0 16px 0;';
    heading.textContent = 'Compact card — Config tab';
    overlay.appendChild(heading);
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.style.cssText = 'margin-bottom:24px;color:var(--muted,#5b6b7d);';
    sub.textContent = 'Read-only view of the current compaction policy, threshold, and distance to next fire.';
    overlay.appendChild(sub);
    const stream = overlay;
    const card = document.createElement('details');
    card.id = 'ctx-deep-demo-compact-card';
    card.className = 'compact-card compact-card-demo';
    card.open = true;
    card.style.margin = '24px auto';
    card.style.maxWidth = '760px';
    const sum = document.createElement('summary');
    sum.className = 'summary';
    const badge = document.createElement('span');
    badge.className = 'compact-badge compact-badge-on-demand';
    badge.textContent = 'on-demand';
    sum.appendChild(badge);
    const label = document.createElement('span');
    label.textContent = '── context compacted ──';
    sum.appendChild(label);
    const tk = document.createElement('span');
    tk.className = 'tokens'; tk.textContent = '6400 tokens'; sum.appendChild(tk);
    const evc = document.createElement('span');
    evc.className = 'events'; evc.textContent = 'compacted 8 events'; sum.appendChild(evc);
    card.appendChild(sum);

    const data = { model: 'deepseek-chat', maxTokens: 512, shadowedTokenCount: 6400,
      shadowedRange: { start: 1, end: 8 },
      summary: [{ type: 'text', text: 'Turn 1 summary retained (system prompt, tool defs, initial query, guardhint).' }],
    };
    const events = window.__ctxDeepDemoEvents || [];
    if (window.__dshCompactCard && window.__dshCompactCard.mountTabs) {
      window.__dshCompactCard.mountTabs(card, {
        document,
        initial: 'config',
        fillPre(body){ body.textContent = '(see events 1–8; summary compressed to 1 line)'; body.style.padding = '8px'; },
        fillPost(body){ body.textContent = data.summary[0].text; body.style.padding = '8px'; },
        fillMeta(body){
          const dl = document.createElement('dl'); dl.className = 'compact-card-tab-meta';
          for (const [k,v] of Object.entries({ Trigger: 'on-demand', Model: data.model, 'Summary cap': '≤512 tok', 'Compacted range': 'seq 1–8', 'Compacted volume': '6400 tok' })) {
            const dt = document.createElement('dt'); dt.textContent = k;
            const dd = document.createElement('dd'); dd.textContent = v;
            dl.appendChild(dt); dl.appendChild(dd);
          }
          body.appendChild(dl);
        },
        fillConfig(body){
          if (!window.__dshCompactConfigModel) { body.textContent = 'model missing'; return; }
          const v = window.__dshCompactConfigModel.buildCompactConfigView(events);
          const dl = document.createElement('dl'); dl.className = 'compact-card-tab-meta compact-config-list';
          const rows = [
            ['Threshold', v.thresholdTokens.toLocaleString() + ' tok' + (v.thresholdSource==='assumed'?' (assumed)':'')],
            ['Strategy', v.strategyName],
            ['Model', v.model || 'deepseek-chat'],
            ['Summary cap', v.maxSummaryTokens != null ? '≤' + v.maxSummaryTokens + ' tok' : 'unknown'],
            ['Triggers fired', v.triggersFired + ' this session'],
            ['Tokens since last compact', v.tokensSinceLastCompact.toLocaleString() + ' tok'],
            ['Tokens until next', v.tokensUntilNext.toLocaleString() + ' tok'],
          ];
          for (const [k, val] of rows) {
            const dt = document.createElement('dt'); dt.textContent = k;
            const dd = document.createElement('dd'); dd.textContent = val;
            dl.appendChild(dt); dl.appendChild(dd);
          }
          body.appendChild(dl);
          const progWrap = document.createElement('div');
          progWrap.className = 'compact-config-progress compact-config-progress--' + v.progressLevel;
          const progHead = document.createElement('div');
          progHead.className = 'compact-config-progress-head';
          const pt = document.createElement('span');
          pt.className = 'compact-config-progress-title'; pt.textContent = 'Progress to next compact';
          const pp = document.createElement('span');
          pp.className = 'compact-config-progress-pct muted small'; pp.textContent = Math.min(100, Math.round(v.progressPct)) + '%';
          progHead.appendChild(pt); progHead.appendChild(pp);
          const track = document.createElement('div'); track.className = 'compact-config-progress-track';
          const fill = document.createElement('div'); fill.className = 'compact-config-progress-fill';
          fill.style.setProperty('--fill-pct', Math.min(100, Math.max(0, v.progressPct)) + '%');
          track.appendChild(fill); progWrap.appendChild(progHead); progWrap.appendChild(track);
          body.appendChild(progWrap);
          const note = document.createElement('div');
          note.className = 'compact-config-note muted small';
          note.textContent = 'Read-only view. Adjust in Settings › Compaction (restart-required until session/set-compact-policy lands, gap G2).';
          body.appendChild(note);
        },
      });
    }
    stream.appendChild(card);
    document.body.appendChild(overlay);
    return 'mounted';
  })()`)
  console.error('compact mount ->', compactMount)
  await wait(400)
  await shoot('ctx-deep-03-compact-config.png')

  // -- SHOT 4: Subagent drill-down tabs -----------------------------------
  // Make sure we're on the Chat tab and any drawers/rails are hidden so the
  // subagent card owns the frame.
  await evj(`(function(){
    if (window.__dshTabs && window.__dshTabs.switchTo) window.__dshTabs.switchTo('chat');
    // Force-show the chat pane and hide every other pane so a mount into
    // #stream can't land off-screen.
    const panes = document.querySelectorAll('.pane[data-pane]');
    for (const p of panes) p.hidden = (p.getAttribute('data-pane') !== 'chat');
    const rail = document.getElementById('context-rail'); if (rail) rail.hidden = true;
    const drawer = document.querySelector('.devtools-drawer'); if (drawer) drawer.style.display = 'none';
    return 'chat-clean';
  })()`)
  await wait(400)
  const subaMount = await evj(`(function(){
    // Build a full-page overlay that covers the whole viewport with a white
    // background — this is a demo shot, so we want the subagent trace to be
    // the whole story. This bypasses any pane routing quirks.
    const prevOverlay = document.getElementById('ctx-deep-demo-overlay');
    if (prevOverlay) prevOverlay.remove();
    const prev = document.getElementById('ctx-deep-demo-subagent');
    if (prev) prev.remove();
    const prevCompact = document.getElementById('ctx-deep-demo-compact-card');
    if (prevCompact) prevCompact.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ctx-deep-demo-overlay';
    overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:var(--bg,#fff);z-index:9999;padding:48px 96px;overflow:auto;font-family:inherit;';
    const heading = document.createElement('h1');
    heading.style.cssText = 'font-size:24px;margin:0 0 16px 0;';
    heading.textContent = 'Subagent trace — drill-down tabs';
    overlay.appendChild(heading);
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.style.cssText = 'margin-bottom:24px;color:var(--muted,#5b6b7d);';
    sub.textContent = 'Tool defs / Inbound query surface at the foot of every subagent card.';
    overlay.appendChild(sub);
    const stream = overlay;

    if (!window.__dshSubagentView || !window.__dshSubagentView.buildInlineSubagentTrace) {
      return 'no-view';
    }
    const now = Date.now();
    const childEvents = [
      { type: 'user/message', seq: 1, time: now, data: { content: [{type:'text', text:'Locate a file called ledger.md and summarise sections 2–4.'}], source: { kind: 'plugin', plugin: 'subagent-search' } } },
      { type: 'tool/call', seq: 2, time: now+10, data: { name: 'read_file', arguments: '{"path":"ledger.md"}' } },
      { type: 'tool/call', seq: 3, time: now+20, data: { name: 'search', arguments: '{"q":"section 2"}' } },
      { type: 'tool/call', seq: 4, time: now+30, data: { name: 'read_file', arguments: '{"path":"appendix.md"}' } },
      { type: 'turn/end', seq: 5, time: now+40, data: { turn: 0, reason: { kind: 'completed' } } },
    ];
    const lastAssistantMessage = [{ type: 'text', text: '\`\`\`json\\n{"summary":"sections 2-4 cover the ledger schema","found":3}\\n\`\`\`' }];
    const spec = {
      parentSessionId: 'parent-sess-1',
      childSessionId: 'child-sess-a',
      status: 'done',
      provider: 'stdio-echo',
      stopReason: 'stop',
      childEvents,
      lastAssistantMessage,
    };
    const trace = window.__dshSubagentView.buildInlineSubagentTrace(document, spec, { collapsed: false });
    trace.id = 'ctx-deep-demo-subagent';
    trace.style.margin = '24px auto';
    trace.style.maxWidth = '760px';
    stream.appendChild(trace);
    trace.open = true;
    // Append the overlay LAST so it sits atop the rest of the page.
    document.body.appendChild(overlay);
    return { hasDrilldown: !!trace.querySelector('.subagent-drilldown') };
  })()`)
  console.error('subagent mount ->', JSON.stringify(subaMount))
  await wait(400)
  await shoot('ctx-deep-04-subagent.png')

  ws.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
