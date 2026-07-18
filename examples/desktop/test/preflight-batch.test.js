// preflight-batch.test.js — lock the preflight fix batch (2026-07-18)
//
// Six items from the team-lead brief:
//   #1 1969 timestamp guards + relative fixture time shift
//   #2 Context-page jargon tooltips (Shadowing / Injections / Recall /
//      Compact policy + already-tooltipped status chips get the extended
//      wording)
//   #3 Status bar chip tooltips (daemon / model / starting dot)
//   #4 Plugins page trims: dedup enabled-count card, neutral border,
//      Vibe subtitle
//   #5 firstRun onboarding gate (fresh user-data pops it, existing skips)
//   #6 mock-reasoning-only fixture ends with a turn/end row so the drawer
//      auto-opens
//
// Guards are source-fingerprint tests (grep the built file for the exact
// tooltip strings) — cheap, stable, catches accidental removal in a
// refactor. Where behaviour is testable in isolation we hit that path
// too (formatTime already covered in fresh-eyes-p0-fixes.test.js and
// tracing-index-model.test.js).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const contextPageSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/context-page.js'), 'utf8')
const indexHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')
const pluginsPageSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/plugins-ui.js'), 'utf8')
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')

// ---------- #2 Context page jargon tooltips ------------------------------

test('#2 Shadowing group title has a plain-English tooltip', () => {
  assert.match(contextPageSrc, /title\.title = 'Shadowing = the daemon compacts older turns/)
})

test('#2 Injections group title has a plain-English tooltip', () => {
  assert.match(contextPageSrc, /title\.title = 'Injections = system prompts \/ plugin context/)
})

test('#2 Recall group title has a plain-English tooltip', () => {
  assert.match(contextPageSrc, /title\.title = 'Recall = tool calls that pulled memory/)
})

test('#2 Compact policy group title has a plain-English tooltip', () => {
  assert.match(contextPageSrc, /title\.title = 'Compact = fold older turns/)
})

test('#2 restart-required / upstream-pending chips explain the G-numbers', () => {
  // Extended shadowing status wording (matches the human phrasing).
  assert.match(contextPageSrc, /restart-required = editable, applied on next session restart\. G2/)
  // Injections chip.
  assert.match(contextPageSrc, /upstream-pending = no wire method yet;.*G4/)
  // Recall chip.
  assert.match(contextPageSrc, /upstream-pending = no wire method yet;.*G3/)
})

// ---------- #3 Status bar chip tooltips ----------------------------------

const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8')

test('#3 statusbar tooltip helper is defined and wired into onStatus + bootUi', () => {
  assert.match(rendererSrc, /function applyStatusBarTooltips\b/, 'helper must exist')
  // onStatus call site — right after statusText assignment.
  assert.match(rendererSrc, /statusText\.textContent = status\s*\n\s*\/\/ Preflight[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*applyStatusBarTooltips\(status, profile, model\)/)
})

test('#3 statusbar tooltip covers idle / starting / running / ready / crashed', () => {
  for (const st of ['idle', 'starting', 'running', 'ready', 'crashed']) {
    assert.match(rendererSrc, new RegExp(`${st}: 'runtime`), `must cover status='${st}'`)
  }
  // Starting chip specifically must explain "spinning up" for the yellow-dot case.
  assert.match(rendererSrc, /starting: 'runtime starting — the daemon is spinning up'/)
})

test('#3 model badge tooltip explains profile vs model', () => {
  assert.match(rendererSrc, /profile: \$\{profile\}\$\{model \? ` · model: \$\{model\}` : ''\}/)
  assert.match(rendererSrc, /Profile picks the runtime binary \+ config; model is what the daemon calls/)
})

// ---------- #4 Plugins page cognitive load -------------------------------

const marketSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/market-ui.js'), 'utf8')

test('#4a summary bar no longer duplicates the enabled count', () => {
  // The old `enabled X of Y` field is gone from renderSummaryBar; conflicts
  // and tool-count warnings still emit (they only appear conditionally).
  assert.doesNotMatch(pluginsPageSrc, /<span class="label">enabled<\/span>/,
    'summary bar must not carry the enabled label anymore')
  // The diagStrip health phrase is still the source of truth.
  assert.match(pluginsPageSrc, /\$\{runtimeSnapshot\.expected\} enabled · \$\{runtimeSnapshot\.active\} running/)
})

test('#4b diagStrip partial-runtime state uses neutral tint, not warn', () => {
  // The mapping is now `active ? 'ok' : ''` — no warn class for partial.
  assert.match(pluginsPageSrc, /runtimeSnapshot\.status === 'active' \? 'ok' : ''/)
  assert.doesNotMatch(pluginsPageSrc, /runtimeSnapshot\.status === 'active' \? 'ok' : 'warn'/)
})

test('#4c Vibe card sub-title uses plain-English phrasing', () => {
  assert.match(marketSrc, /Let the agent write a plugin for you — right in this session\./)
  assert.doesNotMatch(marketSrc, /The agent writes and mounts a plugin at runtime\./,
    'old jargon phrasing must be gone')
})

// ---------- #5 firstRun onboarding gate ---------------------------------

const os = require('node:os')

test('#5 fresh ~/.dsh-desktop reports firstRun=true (sentinel-based gate)', () => {
  const P = require('../src/main/plugins.js')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preflight-'))
  const prev = process.env.DSH_DESKTOP_HOME
  process.env.DSH_DESKTOP_HOME = scratch
  try {
    assert.equal(P.shellHome(), scratch, 'env override must take effect')
    assert.equal(P.onboardedSentinelExists(), false, 'sentinel must not exist in a fresh dir')
    // A directory that only has a growth-log or a stray overlay must still
    // report firstRun=true — only the explicit sentinel counts.
    fs.mkdirSync(scratch, { recursive: true })
    fs.writeFileSync(path.join(scratch, 'growth-log.jsonl'), '{}\n', 'utf8')
    fs.writeFileSync(path.join(scratch, 'config.json'), '{}\n', 'utf8')
    assert.equal(P.onboardedSentinelExists(), false, 'partial dir must still report firstRun=true')
  } finally {
    process.env.DSH_DESKTOP_HOME = prev
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('#5 markOnboarded / clearOnboarded round-trip flips firstRun', () => {
  const P = require('../src/main/plugins.js')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preflight-'))
  const prev = process.env.DSH_DESKTOP_HOME
  process.env.DSH_DESKTOP_HOME = scratch
  try {
    assert.equal(P.onboardedSentinelExists(), false)
    P.markOnboarded()
    assert.equal(P.onboardedSentinelExists(), true, 'markOnboarded must set the sentinel')
    P.clearOnboarded()
    assert.equal(P.onboardedSentinelExists(), false, 'clearOnboarded must remove the sentinel — this is what Reset onboarding relies on')
  } finally {
    process.env.DSH_DESKTOP_HOME = prev
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('#5 onboarding:status handler logs firstRun for future preflight audits', () => {
  // Fingerprint: the console.log line must survive refactors so the next
  // reviewer can inspect the main-process log to distinguish "sentinel
  // stale from prior QA run" (their machine wasn't actually fresh) from
  // "wire path broken".
  assert.match(mainSrc, /\[onboarding:status\] firstRun=/)
})

// ---------- #6 mock-reasoning-only fixture + turn drawer auto-open -------

test('#6 clickfix-reasoning-only fixture ends with turn/end (drawer close signal)', () => {
  const events = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/trace-samples/clickfix-reasoning-only.json'), 'utf8'))
  const last = events[events.length - 1]
  assert.equal(last && last.type, 'turn/end', 'last event must be turn/end so the footer + drawer render')
})

test('#6 playTraceFixture auto-opens the drawer for single-turn fixtures', () => {
  // Fingerprint: the post-play block that walks .turn-trace-drawer and
  // flips drawers[0].open = true when there is exactly one turn.
  assert.match(rendererSrc, /const drawers = document\.querySelectorAll\('\.turn-trace-drawer'\)/)
  assert.match(rendererSrc, /if \(drawers\.length === 1\) \{[^}]*drawers\[0\]\.open = true/s)
})
