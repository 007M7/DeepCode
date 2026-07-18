// Onboarding overlay: 2-step first-run flow that writes
// ~/.dsh-desktop/{config.json, user-overlay.cordis.yml} and restarts the
// runtime so the picked template takes effect immediately.
//
// The overlay lives in the DOM at all times (hidden by default). We only
// show it when window.dsh.onboarding.status() reports firstRun === true, or
// when the user hits "Reset onboarding" and the boot flow reruns.

'use strict'

;(function () {
  const root = document.getElementById('onboarding')
  if (!root) {
    // D36 (drift cycle 18): null-guard. Onboarding UI is scaffolded into
    // index.html at boot, but layout-only surfaces (Playground overlay,
    // isolated test harnesses) load the renderer without the #onboarding
    // container. Silently no-op instead of throwing on `root.querySelector`.
    return
  }
  const step1 = root.querySelector('[data-onboarding-step="1"]')
  const step2 = root.querySelector('[data-onboarding-step="2"]')
  const dots = root.querySelectorAll('.onboarding-progress .dot')

  const state = { role: null, approvalMode: null }

  function goToStep(n) {
    step1.hidden = n !== 1
    step2.hidden = n !== 2
    dots.forEach((d) => {
      d.classList.toggle('on', Number(d.dataset.step) <= n)
    })
  }

  function pickRole(role) {
    state.role = role
    for (const btn of step1.querySelectorAll('[data-role]')) {
      btn.classList.toggle('selected', btn.dataset.role === role)
    }
    // A short delay so the click feedback is visible before the step
    // transition — kept synchronous otherwise so a user who clicks fast
    // doesn't see a jarring skip.
    setTimeout(() => goToStep(2), 120)
  }

  async function pickApproval(mode) {
    state.approvalMode = mode
    for (const btn of step2.querySelectorAll('[data-approval]')) {
      btn.classList.toggle('selected', btn.dataset.approval === mode)
    }
    await commit()
  }

  async function commit() {
    if (!state.role || !state.approvalMode) return
    root.classList.add('committing')
    try {
      await window.dsh.onboarding.apply(state.role, state.approvalMode)
    } catch (err) {
      root.classList.remove('committing')
      // C22 (drift cycle 18): non-blocking modal instead of native alert.
      // Native alert() would steal focus mid-onboarding and block the
      // async return; the shared dialog reads as an app notice.
      const notify = window.__dshRenderer && window.__dshRenderer.notifyDialog
      if (notify) notify(`onboarding failed: ${err.message}`)
      else alert(`onboarding failed: ${err.message}`)
      return
    }
    // Success — dismiss + refresh the plugins tab so if the user opens it
    // the new overlay is already loaded.
    root.hidden = true
    root.classList.remove('committing')
    state.role = null
    state.approvalMode = null
    goToStep(1)
    for (const b of root.querySelectorAll('.selected')) b.classList.remove('selected')
    if (window.__dshPlugins) void window.__dshPlugins.refresh()
  }

  async function skip() {
    // Skip == the coding + ask defaults; matches applyRoleTemplate's most
    // capable role and its safer approval preference.
    state.role = 'coding'
    state.approvalMode = 'ask'
    await commit()
  }

  step1.querySelectorAll('[data-role]').forEach((btn) => {
    btn.addEventListener('click', () => pickRole(btn.dataset.role))
  })
  step2.querySelectorAll('[data-approval]').forEach((btn) => {
    btn.addEventListener('click', () => { void pickApproval(btn.dataset.approval) })
  })
  root.querySelector('[data-onboarding-action="skip"]').addEventListener('click', () => { void skip() })
  root.querySelector('[data-onboarding-action="back"]').addEventListener('click', () => goToStep(1))

  // Boot check: the renderer calls window.__dshOnboarding.maybeShow() at
  // startup so it can await it before the profile switcher fires.
  async function maybeShow() {
    try {
      const status = await window.dsh.onboarding.status()
      if (status.firstRun) {
        root.hidden = false
        goToStep(1)
      }
    } catch (err) {
      console.debug('onboarding status unavailable:', err.message)
    }
  }

  function forceShow() {
    root.hidden = false
    goToStep(1)
  }

  window.__dshOnboarding = { maybeShow, forceShow }
})()
