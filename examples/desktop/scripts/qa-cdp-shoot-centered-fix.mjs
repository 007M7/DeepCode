// Reshoot script for task #221 (centered-card root fix). Reproduces the
// t141 selfie set (19-approval / 21-exit-plan / 22-steer-chip+card /
// 23-triggers-t2-t4-t5) via CDP against an Electron shell running with
// DSH_QA=1, so we can verify the four in-stream card families now render
// full-width and left-aligned. See docs/design-refs/density-layering-spec.md
// §7 "centered-card ban" for the rule these shots prove.
//
// Approach: fire the real renderer entry points where they exist
// (`__dshRenderer.showSteerCard`, `.maybeAppendTriggerCard`), and click
// the shipped `mock-approval` debug button for the approval card. For the
// exit-plan-mode card, whose builder is module-local, hand-mount a DOM
// tree that matches renderer.js:3967-4050 class-for-class — the point of
// the shot is the outer `.card.form.exit-plan-mode` box, which is what
// the CSS rule under test governs.
//
// Runs on a spare CDP port (default 9237) so it doesn't collide with a
// user-visible Electron instance. Node built-in WebSocket sends no Origin
// header, which Chromium accepts (avoids the 403 gotcha browsers hit).

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const port = process.argv[2] || '9237'
const outdir = process.argv[3] || 'docs/demo-shots/centered-fix-01'
mkdirSync(outdir, { recursive: true })

async function main() {
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
  const call = (m, p = {}, timeoutMs = 15000) => new Promise((ok, err) => {
    const _id = id++
    const timer = setTimeout(() => { pending.delete(_id); err(new Error('cdp timeout: ' + m)) }, timeoutMs)
    pending.set(_id, [(v) => { clearTimeout(timer); ok(v) }, (e) => { clearTimeout(timer); err(e) }])
    ws.send(JSON.stringify({ id: _id, method: m, params: p }))
  })
  // evj runs `expr` inside an IIFE with an implicit `return`. Wrap any
  // multi-statement expression yourself if you need `;`.
  const evj = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: `(async()=>{try{return (${expr})}catch(e){return {__err: String(e)}}})()`,
      returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }

  await call('Page.enable')
  const reveal = await evj(`window.dshQa && window.dshQa.revealWindow ? await window.dshQa.revealWindow() : null`)
  console.error('reveal ->', JSON.stringify(reveal))
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  })

  const shoot = async (name) => {
    // Settle longer to let post-mount layout finish; some cards (exit-plan
    // wrap, steer card status strip) trigger a second reflow after the
    // initial paint. 700ms is empirically enough on this machine.
    await new Promise((r) => setTimeout(r, 700))
    // Screenshot with a 30s timeout — the default 15s occasionally trips on
    // the second/third shot when the compositor is under load, and retry
    // once on timeout so a single flake doesn't lose the shot.
    let shot
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        shot = await call('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width: 1440, height: 900, scale: 2 },
        }, 30000)
        break
      } catch (e) {
        if (attempt === 2) throw e
        console.error(`  shoot ${name} attempt ${attempt + 1} failed: ${e.message}, retrying`)
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    const path = resolve(outdir, `${name}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    console.log(path)
  }

  // Dismiss the onboarding modal (first-boot) if it's up. It grays out the
  // whole app and none of the mock injectors reach the stream through it.
  // The modal's "Skip and use defaults" button dismisses without asking
  // the user to pick a profile.
  await evj(`(function(){
    const btns = Array.from(document.querySelectorAll('button'));
    const skip = btns.find(b => /skip and use defaults/i.test(b.textContent || ''));
    if (skip) { skip.click(); return 'onboarding dismissed'; }
    return 'no-onboarding';
  })()`).then(r => console.error('onboarding ->', r))
  await new Promise((r) => setTimeout(r, 400))

  // Fresh boots land on whichever tab was last saved (often PRs). Force
  // chat via the tab seam if present, or by clicking the sidebar nav item.
  await evj(`(function(){
    if (window.__dshTabs && window.__dshTabs.switchTo) {
      window.__dshTabs.switchTo('chat');
      return 'via seam';
    }
    // Fallback: click the "Chat" nav-item in the observation group.
    const items = Array.from(document.querySelectorAll('.nav-item, [data-tab]'));
    for (const el of items) {
      if (/^chat$/i.test((el.textContent || '').trim()) || el.dataset.tab === 'chat') {
        el.click();
        return 'via click';
      }
    }
    return 'no-chat-target';
  })()`).then(r => console.error('switch chat ->', r))
  // Close the Devtools drawer if it's open — it obscures the right edge of
  // in-stream cards and is unrelated to the shot's intent. The real class
  // (per src/renderer/devtools-panel.js:88) is `.devtools-drawer`; we hide
  // it via style since there's no exposed close button on the drawer chrome.
  await evj(`(function(){
    const d = document.querySelector('.devtools-drawer');
    if (d) { d.style.display = 'none'; return 'hidden'; }
    return 'no-drawer';
  })()`).then(r => console.error('devtools close ->', r))
  await new Promise((r) => setTimeout(r, 300))

  // Report what the stream looks like right now (before any injection).
  const preflight = await evj(`(function(){
    const s = document.querySelector('.stream');
    return {
      hasStream: !!s,
      streamWidth: s ? Math.round(s.getBoundingClientRect().width) : null,
      hasRenderer: !!window.__dshRenderer,
      showSteer: !!(window.__dshRenderer && window.__dshRenderer.showSteerCard),
      maybeTrigger: !!(window.__dshRenderer && window.__dshRenderer.maybeAppendTriggerCard),
      hasMockApproval: !!document.getElementById('mock-approval'),
      activeSession: window.__dshRenderer && window.__dshRenderer.getActiveSessionId && window.__dshRenderer.getActiveSessionId(),
    };
  })()`)
  console.error('preflight ->', JSON.stringify(preflight))

  // Helper: wipe any leftover cards / plan wraps / steer chips from
  // the stream so successive shots don't stack. Kept as a callable expr.
  const clearExpr = `(function(){
    const s = document.querySelector('.stream');
    if (!s) return 'no-stream';
    for (const c of Array.from(s.querySelectorAll('.card, .exit-plan-mode-wrap, .steer-chip'))) c.remove();
    return 'cleared';
  })()`

  // --- 19: approval card ----------------------------------------------------
  await evj(clearExpr)
  const clickRes = await evj(`(function(){
    const b = document.getElementById('mock-approval');
    if (!b) return 'no-button';
    b.click();
    return { present: !!document.querySelector('.card.approval') };
  })()`)
  console.error('19 mock-approval click ->', JSON.stringify(clickRes))
  await shoot('19-approval-waiting')

  // --- 21: exit-plan-mode ---------------------------------------------------
  await evj(clearExpr)
  const planMount = await evj(`(function(){
    const stream = document.querySelector('.stream');
    if (!stream) return 'no-stream';
    // Mount the exact DOM the renderer builds at renderer.js:3967-4050.
    // The shot's job is to verify the outer .card.form.exit-plan-mode box
    // is full-width — that comes from the density-spec §7 rule under test.
    const wrap = document.createElement('div');
    wrap.className = 'exit-plan-mode-wrap';
    const el = document.createElement('div');
    el.className = 'card form exit-plan-mode';
    const h = document.createElement('h4');
    h.textContent = 'Exit plan mode?';
    el.appendChild(h);
    const desc = document.createElement('div');
    desc.className = 'label';
    desc.textContent = 'Review the plan below. Edit if needed, add a comment, then confirm to leave plan mode.';
    el.appendChild(desc);
    const planLabel = document.createElement('div');
    planLabel.className = 'exit-plan-mode-section-label';
    planLabel.textContent = 'PLAN';
    el.appendChild(planLabel);
    const planInput = document.createElement('textarea');
    planInput.className = 'exit-plan-mode-plan';
    planInput.rows = 5;
    planInput.value = '1. Read src/renderer/session-tree-page.js for the fork-tree render path.\\n2. Add a highlight to selected fork rows.\\n3. Update snapshot tests.\\n4. Reshoot selfie 01 and 02.';
    el.appendChild(planInput);
    const commentLabel = document.createElement('div');
    commentLabel.className = 'exit-plan-mode-section-label';
    commentLabel.textContent = 'COMMENT';
    el.appendChild(commentLabel);
    const commentInput = document.createElement('textarea');
    commentInput.className = 'exit-plan-mode-comment';
    commentInput.rows = 2;
    commentInput.placeholder = 'add a note before confirming';
    el.appendChild(commentInput);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.style.marginTop = '10px';
    actions.innerHTML = '<button class="ghost small">Confirm</button><button class="ghost small">Skip</button>';
    el.appendChild(actions);
    wrap.appendChild(el);
    const rail = document.createElement('div');
    rail.className = 'plan-diff-rail';
    rail.innerHTML = "<div class='exit-plan-mode-section-label' style='padding:8px 12px'>PLAN PREVIEW</div>";
    wrap.appendChild(rail);
    stream.appendChild(wrap);
    return 'mounted';
  })()`)
  console.error('21 exit-plan mount ->', JSON.stringify(planMount))
  await shoot('21-exit-plan-mode')

  // --- 22: steer chip + steer card -----------------------------------------
  await evj(clearExpr)
  const steerRes = await evj(`(function(){
    const R = window.__dshRenderer;
    if (!R) return 'no-renderer';
    const sid = R.getActiveSessionId && R.getActiveSessionId();
    const stream = document.querySelector('.stream');
    if (!stream) return 'no-stream';
    // Prior-turn steer chip (chat-stream row above the card).
    const chip = document.createElement('div');
    chip.className = 'steer-chip';
    chip.innerHTML = "<span class='steer-chip-label'>steer: read isolated-daemon spawn env</span>";
    stream.appendChild(chip);
    if (typeof R.showSteerCard !== 'function') return 'no-showSteerCard';
    R.showSteerCard({
      interruptId: 'mock-steer-' + Date.now(),
      sessionId: sid,
      spec: {
        title: 'Suggestion',
        message: 'This subagent has been idle for 45s. Nudge it to summarise progress?',
        suggestions: [
          { label: 'Ask for a status update' },
          { label: 'Cancel this subagent' },
        ],
      },
    });
    return { chip: !!document.querySelector('.steer-chip'), card: !!document.querySelector('.card.steer') };
  })()`)
  console.error('22 steer mount ->', JSON.stringify(steerRes))
  await shoot('22-steer-chip-and-card')

  // --- 23: trigger family t2 / t4 / t5 --------------------------------------
  // `maybeAppendTriggerCard` classifies via templateFromEvent + widget
  // registry — feeding it a synthetic dummy that doesn't match a template
  // produces zero cards, and the widget registry is dependency-injected
  // by the shell at boot. For a CSS-width shot we build the same DOM the
  // renderer would build (class-for-class match with renderer.js:3688-
  // 3703) so the outer .card.trigger-card box behaviour under test is
  // exercised on the real class chain.
  await evj(clearExpr)
  const trigRes = await evj(`(function(){
    const stream = document.querySelector('.stream');
    if (!stream) return 'no-stream';
    const mk = (kind, badge, title, body) => {
      const wrap = document.createElement('div');
      wrap.className = 'card trigger-card trigger-' + kind;
      wrap.dataset.triggerKind = kind;
      const b = document.createElement('div');
      b.className = 'trigger-badge';
      b.textContent = badge;
      wrap.appendChild(b);
      const h = document.createElement('div');
      h.style.fontSize = '13px';
      h.style.fontWeight = '600';
      h.style.marginBottom = '4px';
      h.textContent = title;
      wrap.appendChild(h);
      const body_ = document.createElement('div');
      body_.style.fontSize = '12px';
      body_.style.color = 'var(--muted)';
      body_.textContent = body;
      wrap.appendChild(body_);
      stream.appendChild(wrap);
    };
    mk('t2-error-recovery', 'ERROR RECOVERY',
      'Runtime disconnected — reconnect?',
      'Last error: EPIPE at daemon-bridge:112. Reconnect or skip?');
    mk('t4-artifact-preview', 'ARTIFACT',
      'artifact ready — session-tree.html',
      'Preview available on http://127.0.0.1:9411/artifacts/session-tree.html');
    mk('t5-context-warning', 'CONTEXT HEALTH',
      'Context is 89% full — compact recommended',
      'The next turn may not fit in the model window; compact now to preserve continuity.');
    return { count: document.querySelectorAll('.card.trigger-card').length };
  })()`)
  console.error('23 triggers mount ->', JSON.stringify(trigRes))
  await shoot('23-triggers-t2-t4-t5')

  // Report card widths so we have a numeric receipt in the run log — proves
  // full-width was achieved and not just visually inferred.
  const widths = await evj(`(function(){
    const s = document.querySelector('.stream');
    if (!s) return null;
    const sw = Math.round(s.getBoundingClientRect().width);
    const cards = Array.from(document.querySelectorAll('.stream .card, .stream .exit-plan-mode-wrap, .stream .steer-chip'));
    return { streamWidth: sw, boxWidths: cards.map(c => ({ cls: c.className, w: Math.round(c.getBoundingClientRect().width) })) };
  })()`)
  console.error('post-shot widths ->', JSON.stringify(widths, null, 2))

  await call('Emulation.clearDeviceMetricsOverride')
  ws.close()
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
