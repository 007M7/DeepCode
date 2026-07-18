// QA harness — enabled only when the URL hash contains #qa. Walks every
// visible button/select/interactive control, clicks it, and logs the
// pre/post state. Any thrown error or console error becomes a JSON row in
// the final report the harness prints via console.log('QA_REPORT:', …).
//
// This is a dev-only aid; production launches never carry #qa.
'use strict'

;(function () {
  if (typeof window === 'undefined') return
  if (!location.hash.includes('qa')) return

  const results = []
  const errors = []
  const origErr = console.error
  const origWarn = console.warn
  console.error = function (...args) {
    errors.push({ level: 'error', args: args.map(String) })
    origErr.apply(this, args)
  }
  window.addEventListener('error', (e) => {
    errors.push({ level: 'window-error', message: e.message, source: e.filename, line: e.lineno })
  })
  window.addEventListener('unhandledrejection', (e) => {
    errors.push({ level: 'unhandled-rejection', message: String(e.reason) })
  })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Guardrails: these controls do irreversible things when clicked
  // (restart runtime, confirm() dialogs, real network) — skip in harness.
  const SKIP = new Set([
    'reset-onboarding',  // confirm() dialog blocks harness
    'plugins-apply',     // restarts the runtime
    'playground-apply',  // commits overlay + restart
    'playground-discard',// tears down scratch daemon
    'plugins-add',       // opens a file picker
    'plugins-probe',     // spins an isolated daemon
    'plugins-playground',// opens playground pane and spawns runtime
    'pr-refresh',        // shells out to gh
    'pr-refresh-btn',    // shells out to gh
    // Bug D (2026-07-18): mock-fork-compare pops a full-viewport overlay
    // that obscures every following harness assertion.  It has no
    // meaningful click-through result to record anyway, so skip in the
    // harness sweep; humans still exercise it via the Debug popover.
    'mock-fork-compare',
  ])

  function describe(el) {
    const parts = []
    if (el.id) parts.push(`#${el.id}`)
    if (el.classList && el.classList.length) parts.push(`.${el.classList[0]}`)
    for (const attr of ['data-action', 'data-role', 'data-approval', 'data-tab',
                        'data-mission-tab', 'data-pr-filter', 'data-onboarding-action',
                        'data-hint', 'data-toggle']) {
      const v = el.getAttribute && el.getAttribute(attr)
      if (v) parts.push(`[${attr}="${v}"]`)
    }
    return parts.join('') || el.tagName.toLowerCase()
  }

  function snapshot() {
    return {
      bodyClass: document.body.className,
      openPopovers: document.querySelectorAll('.debug-popover[data-open="true"]').length,
      layoutDropdownOpen: document.querySelector('.layout-indicator-dropdown:not([hidden])') ? 1 : 0,
      activePane: (document.querySelector('.main .pane:not([hidden])') || {}).dataset?.pane,
      activeTab: (document.querySelector('.tab-btn.active') || {}).dataset?.tab,
      missionSubview: (document.querySelector('.mission-subview-tab.active') || {}).dataset?.missionTab,
      prFilterState: (() => {
        // Capture the .active chip's data-pr-filter directly from the DOM
        // (not from the state object it mirrors) so we can tell whether the
        // click landed a class-flip even before pr-page.js re-renders.
        const chips = document.querySelectorAll('.pr-filter-chip')
        return Array.from(chips).map((c) => `${c.dataset.prFilter}:${c.classList.contains('active') ? '1' : '0'}`).join(',')
      })(),
      layoutBtnLabel: (() => {
        const b = document.querySelector('.layout-indicator-btn')
        return b ? b.textContent.trim().slice(0, 20) : null
      })(),
      streamChildCount: (document.getElementById('stream') || { children: [] }).children.length,
      inputValueLen: (document.getElementById('input') || { value: '' }).value.length,
      onboardingHidden: (document.getElementById('onboarding') || {}).hidden,
      onboardingStep: (() => {
        const s1 = document.querySelector('[data-onboarding-step="1"]')
        const s2 = document.querySelector('[data-onboarding-step="2"]')
        if (s1 && !s1.hidden) return 1
        if (s2 && !s2.hidden) return 2
        return 0
      })(),
      quickchatOpen: !!document.querySelector('.quickchat-scrim:not([hidden])'),
    }
  }

  async function clickAndRecord(el, label, opts = {}) {
    const before = snapshot()
    const startErrs = errors.length
    let clicked = true
    try {
      el.click()
    } catch (e) {
      clicked = false
      errors.push({ level: 'click-throw', label, message: e.message })
    }
    await sleep(opts.wait || 40)
    const after = snapshot()
    const changed = JSON.stringify(before) !== JSON.stringify(after)
    const newErrs = errors.slice(startErrs)
    results.push({
      label,
      clicked,
      changed,
      before,
      after,
      newErrors: newErrs,
    })
    return { changed, newErrs }
  }

  async function run() {
    await sleep(1500)  // let boot + async populate settle

    // 1. Header controls (chat pane)
    const controls = [
      ['#quickchat-open', 'header: Quick chat button'],
      ['.brand-search', 'sidebar: brand search glyph'],
      ['#debug-toggle', 'header: Debug popover toggle'],
    ]
    for (const [sel, label] of controls) {
      const el = document.querySelector(sel)
      if (!el) { results.push({ label, missing: true }); continue }
      await clickAndRecord(el, label)
    }

    // 2. Debug popover: open, then click every mock button inside
    const debugToggle = document.getElementById('debug-toggle')
    if (debugToggle) {
      debugToggle.click(); await sleep(80)
      const mocks = document.querySelectorAll('#debug-popover .debug button')
      for (const btn of mocks) {
        if (SKIP.has(btn.id)) continue
        await clickAndRecord(btn, `mock: #${btn.id}`, { wait: 60 })
      }
      // Close popover
      debugToggle.click(); await sleep(40)
    }

    // 3. Layout indicator dropdown — user-flagged bug
    const layoutBtn = document.querySelector('.layout-indicator-btn')
    if (layoutBtn) {
      await clickAndRecord(layoutBtn, 'layout: open dropdown')
      // Every dropdown item
      const items = document.querySelectorAll('.layout-indicator-dropdown .layout-indicator-item')
      for (const item of items) {
        // Reopen since previous click closed it
        if (document.querySelector('.layout-indicator-dropdown[hidden]')) {
          layoutBtn.click(); await sleep(40)
        }
        const hint = item.dataset.hint || item.textContent.trim()
        const before = { bodyClass: document.body.className }
        item.click()
        await sleep(80)
        const after = { bodyClass: document.body.className }
        results.push({
          label: `layout item: ${hint}`,
          before, after,
          changed: before.bodyClass !== after.bodyClass,
        })
      }
    } else {
      results.push({ label: 'layout indicator button', missing: true })
    }

    // 4. Empty-welcome prompt chips
    for (const chip of document.querySelectorAll('.empty-welcome .prompt-chip')) {
      const action = chip.getAttribute('data-action') || 'prompt'
      await clickAndRecord(chip, `chip: ${action}`, { wait: 80 })
      // Reset: switch back to chat
      if (window.__dshTabs) window.__dshTabs.switchTo('chat')
      await sleep(30)
      // Clear the composer so next chip's prompt-seed check is meaningful
      const input = document.getElementById('input')
      if (input) input.value = ''
    }

    // 5. Sidebar top-level nav
    for (const tab of ['chat', 'mission', 'plugins', 'prs', 'chat']) {
      const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`)
      if (!btn) continue
      await clickAndRecord(btn, `nav: ${tab}`, { wait: 80 })
    }

    // 6. Sessions + new-session
    const newBtn = document.getElementById('new-session')
    if (newBtn) await clickAndRecord(newBtn, 'sidebar: New session', { wait: 80 })

    // 7. Composer buttons
    const sendBtn = document.getElementById('send')
    if (sendBtn) {
      const input = document.getElementById('input')
      if (input) input.value = ''
      // Click with empty input — should not send anything
      await clickAndRecord(sendBtn, 'composer: Send (empty)')
    }
    const cancelBtn = document.getElementById('cancel')
    if (cancelBtn) await clickAndRecord(cancelBtn, 'composer: Cancel (idle)')
    const ctxBtn = document.getElementById('ctx-compact-btn')
    if (ctxBtn) await clickAndRecord(ctxBtn, 'statusbar: Compact')

    // 8. Mission page
    if (window.__dshTabs) window.__dshTabs.switchTo('mission')
    await sleep(80)
    for (const tab of ['tree', 'topo', 'board']) {
      const btn = document.querySelector(`[data-mission-tab="${tab}"]`)
      if (btn) await clickAndRecord(btn, `mission subview: ${tab}`, { wait: 40 })
    }
    const missionRefresh = document.getElementById('mission-refresh')
    if (missionRefresh) await clickAndRecord(missionRefresh, 'mission: sidebar refresh')

    // 9. Plugins page
    if (window.__dshTabs) window.__dshTabs.switchTo('plugins')
    await sleep(80)
    for (const id of ['plugins-refresh']) {
      const el = document.getElementById(id)
      if (el) await clickAndRecord(el, `plugins: #${id}`, { wait: 80 })
    }
    // Market subnav — if present (rendered by market-ui.js)
    for (const sub of document.querySelectorAll('.market-subnav button, .subnav-tab, [data-market-tab]')) {
      const key = sub.getAttribute('data-market-tab') || sub.textContent.trim()
      await clickAndRecord(sub, `plugins subnav: ${key}`, { wait: 60 })
    }

    // 10. PRs page
    if (window.__dshTabs) window.__dshTabs.switchTo('prs')
    await sleep(80)
    // Ensure PRs page mounted (handlers bind on mount()). If not, force it.
    if (window.__dshPRs && typeof window.__dshPRs.mount === 'function') {
      try { window.__dshPRs.mount() } catch (_) {}
    }
    await sleep(80)
    for (const chip of document.querySelectorAll('.pr-filter-chip')) {
      const label = `pr filter: ${chip.dataset.prFilter}`
      const active0 = chip.classList.contains('active') ? 1 : 0
      chip.click()
      await sleep(60)
      const active1 = chip.classList.contains('active') ? 1 : 0
      results.push({
        label, clicked: true,
        changed: active0 !== active1,
        before: { activeClass: active0 },
        after: { activeClass: active1 },
        newErrors: [],
      })
    }

    // 11. Onboarding controls — force show and click each
    if (window.__dshOnboarding && typeof window.__dshOnboarding.forceShow === 'function') {
      window.__dshOnboarding.forceShow()
      await sleep(100)
      const roles = document.querySelectorAll('.onboarding-choice[data-role]')
      for (const r of roles) {
        // pickRole uses setTimeout(…, 120) before advancing to step 2 — wait longer.
        await clickAndRecord(r, `onboarding role: ${r.dataset.role}`, { wait: 200 })
        // Return to step 1
        const back = document.querySelector('[data-onboarding-action="back"]')
        if (back) { back.click(); await sleep(60) }
      }
      const skip = document.querySelector('[data-onboarding-action="skip"]')
      if (skip) await clickAndRecord(skip, 'onboarding: skip', { wait: 40 })
    }

    // Emit results
    const summary = {
      totalControls: results.length,
      changed: results.filter((r) => r.changed).length,
      unchanged: results.filter((r) => !r.changed && !r.missing).length,
      missing: results.filter((r) => r.missing).length,
      globalErrors: errors,
    }
    console.log('QA_SUMMARY:', JSON.stringify(summary))
    console.log('QA_REPORT_JSON:', JSON.stringify(results))
    // Also stash on window so a human inspecting the app can see it
    window.__qaReport = { summary, results, errors }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    run().catch((e) => console.error('QA harness failed:', e))
  } else {
    window.addEventListener('load', () => { run().catch((e) => console.error('QA harness failed:', e)) })
  }
})()
