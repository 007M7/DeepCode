// Bug C (2026-07-18) — Runtime warning tri-partite fix:
//   (1) classifyRuntimeError knows more raw-message shapes and no longer
//       falls through to the generic "Runtime warning" for cold-start noise
//       and boot fallback (both were the shapes the user saw as "runtime
//       looks broken");
//   (2) the boot-phase noise gate suppresses classified boot-only errors
//       until onInitialized clears it — a real problem post-init still gets
//       through;
//   (3) same-raw-message dedupe: firing the same error twice bumps a `×N`
//       counter on the existing banner instead of tearing down + rebuilding.
//
// This test drives classifyRuntimeError as a pure function and static-checks
// that showRuntimeErrorBanner honors the boot gate + dedupe by scanning the
// renderer source for the guard patterns. Full-DOM banner exercise lives in
// the isolated Electron probe (docs/qa-ui-hotfix/); node-side we lock the
// classification table and the guard patterns so they don't silently regress.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js')

// Extract the classifyRuntimeError function body from renderer.js and
// evaluate it in an isolated scope. Cheaper than booting the full renderer
// (which needs a full DOM + preload bridge). Regex is anchored so a rename
// of the function fails loudly rather than silently miss the check.
function loadClassifier() {
  const src = fs.readFileSync(RENDERER_PATH, 'utf8')
  const m = src.match(/function classifyRuntimeError\s*\(raw\)\s*{([\s\S]*?)\n}\n/)
  if (!m) throw new Error('classifyRuntimeError() not found in renderer.js — did it move or get renamed?')
  const body = m[1]
  // eslint-disable-next-line no-new-func
  return new Function('raw', body)
}

const classify = loadClassifier()

test('Bug C: interruptions/userInteraction shape → specific title', () => {
  const c = classify('jsonrpc client announced capabilities.interruptions=true but the composition has no ctx.userInteraction registered')
  assert.equal(c.title, 'Interactive prompts unavailable in this profile')
  assert.notEqual(c.bootNoise, true) // real, actionable — surfaces even in boot phase
})

test('Bug C: daemon boot fallback → informational, marked bootNoise', () => {
  const c = classify('daemon boot failed, falling back to stdio: EACCES')
  assert.equal(c.title, 'Falling back to stdio runtime')
  assert.equal(c.icon, 'i', 'boot fallback is informational — not an alarm icon')
  assert.equal(c.bootNoise, true)
})

test('Bug C: ECONNREFUSED cold-start → runtime-not-ready + bootNoise', () => {
  const c = classify('connect ECONNREFUSED /tmp/dsh-daemon.sock')
  assert.equal(c.title, 'Runtime not ready')
  assert.equal(c.bootNoise, true)
})

test('Bug C: EPIPE cold-start → same bucket (bootNoise)', () => {
  const c = classify('write EPIPE on daemon socket')
  assert.equal(c.title, 'Runtime not ready')
  assert.equal(c.bootNoise, true)
})

test('Bug C: socket hang up → bootNoise', () => {
  const c = classify('Error: socket hang up')
  assert.equal(c.title, 'Runtime not ready')
  assert.equal(c.bootNoise, true)
})

test('Bug C: ENOENT missing runtime file → not bootNoise (real config issue)', () => {
  const c = classify('spawn ENOENT: no such file /usr/local/bin/dsh-runtime')
  assert.equal(c.title, 'Runtime file missing')
  assert.notEqual(c.bootNoise, true)
})

test('Bug C: EADDRINUSE port taken → not bootNoise (needs user action)', () => {
  const c = classify('bind EADDRINUSE 127.0.0.1:9000')
  assert.equal(c.title, 'Port already in use')
  assert.notEqual(c.bootNoise, true)
})

test('Bug C: unknown shape still falls back to generic', () => {
  const c = classify('some completely unexpected daemon message')
  assert.equal(c.title, 'Runtime warning')
  assert.notEqual(c.bootNoise, true)
})

// ---- Default-profile-real (2026-07-18) --------------------------------------

test('Default-profile-real: missing DEEPSEEK_API_KEY → dedicated bucket with switchTarget', () => {
  // Exact line thrown by llm-deepseek/src/index.ts:57 — locking the raw
  // shape here so a future adapter rename or reword can't silently strand
  // this bucket back on the generic "Runtime warning".
  const c = classify('llm-deepseek: an API key is required (Config.apiKey or $DEEPSEEK_API_KEY)')
  assert.equal(c.title, 'DEEPSEEK_API_KEY needed for real-model profile')
  // stdio-echo, not daemon-echo (P0-3, 2026-07-18): daemon-demo isn't on
  // deepseek-harness master, so pointing a fresh-clone user at daemon-echo
  // would preflight-fail on the missing daemon bin. stdio-echo boots the
  // jsonrpc-demo bin (present on master) and is keyless, so it works.
  assert.equal(c.switchTarget, 'stdio-echo', 'switchTarget must offer a keyless profile that works on master')
  assert.ok(c.switchLabel && /keyless/i.test(c.switchLabel), 'switchLabel should name the keyless demo')
  // Not bootNoise — a first-run user without the key will hit this DURING
  // boot; if we marked it bootNoise=true they would never see the card
  // until re-initialize (which won't happen).
  assert.notEqual(c.bootNoise, true)
})

test('Default-profile-real: alternate api-key shapes still match', () => {
  // Downstream reword resilience: variants the runtime might throw as
  // llm-deepseek evolves, or that other DeepSeek-family plugins might use.
  const c1 = classify('Error: API key is required. Set DEEPSEEK_API_KEY environment variable.')
  assert.equal(c1.title, 'DEEPSEEK_API_KEY needed for real-model profile')
  const c2 = classify('DEEPSEEK_API_KEY is required for the deepseek llm plugin')
  assert.equal(c2.title, 'DEEPSEEK_API_KEY needed for real-model profile')
})

test('Default-profile-real: showRuntimeErrorBanner renders a switch button when classification.switchTarget is present', () => {
  const src = fs.readFileSync(RENDERER_PATH, 'utf8')
  // Locate showRuntimeErrorBanner and static-check the switch-button
  // scaffolding: (a) consults classification.switchTarget, (b) wires
  // window.dsh.startRuntime to it, (c) removes the banner on success so
  // the user isn't left staring at both the card and the re-boot.
  const startIdx = src.indexOf('function showRuntimeErrorBanner')
  assert.notEqual(startIdx, -1, 'showRuntimeErrorBanner not found')
  const body = src.slice(startIdx, startIdx + 5000)
  assert.match(body, /classification\.switchTarget/, 'switchTarget must be consulted in showRuntimeErrorBanner')
  assert.match(body, /window\.dsh\.startRuntime\(classification\.switchTarget\)/, 'switch button must call startRuntime with the classification target')
  assert.match(body, /banner\.remove\(\)/, 'banner must be removed on successful switch to avoid stale card')
})

// ---- Guard patterns in renderer.js (static locks) ------------------------

test('Bug C: showRuntimeErrorBanner honors _bootPhaseNoise gate on classified boot noise', () => {
  const src = fs.readFileSync(RENDERER_PATH, 'utf8')
  // The gate must live inside showRuntimeErrorBanner and reference both
  // _bootPhaseNoise and the classification's bootNoise field, and it must
  // early-return (no banner build) when both are true.
  assert.match(
    src,
    /function showRuntimeErrorBanner[\s\S]{0,1200}_bootPhaseNoise[\s\S]{0,120}classification\.bootNoise/,
    'showRuntimeErrorBanner must consult _bootPhaseNoise + classification.bootNoise to suppress cold-start noise',
  )
})

test('Bug C: same-raw-message dedupe bumps ×N counter instead of rebuilding banner', () => {
  const src = fs.readFileSync(RENDERER_PATH, 'utf8')
  // Two markers of the dedupe: _lastBannerRaw comparison + a ×N counter
  // update on the .chat-runtime-banner-title element.
  assert.match(
    src,
    /_lastBannerRaw\s*===\s*raw/,
    '_lastBannerRaw comparison missing — the dedupe guard is what folds re-fires',
  )
  assert.match(
    src,
    /_bannerRepeatCount\s*\+=\s*1[\s\S]{0,300}×\$\{_bannerRepeatCount\}/,
    '×N fold render missing — dedupe path must show ×N to the user',
  )
})

test('Bug C: onInitialized clears the boot-phase gate + dedupe memory', () => {
  const src = fs.readFileSync(RENDERER_PATH, 'utf8')
  // Locate the onInitialized callback; take a generous window from its
  // start to search inside — the callback body is long but bounded.
  const startIdx = src.indexOf('window.dsh.onInitialized((info)')
  assert.notEqual(startIdx, -1, 'onInitialized callback not found — did it move?')
  const body = src.slice(startIdx, startIdx + 3000)
  assert.match(body, /_bootPhaseNoise\s*=\s*false/, 'onInitialized must clear _bootPhaseNoise')
  assert.match(body, /_lastBannerRaw\s*=\s*''/, 'onInitialized must clear _lastBannerRaw so a new run starts fresh')
})

// ---- HARNESS_DEV phantom-path (2026-07-18, fix/harness-dev-guard) --------

test('Harness-dev-guard: preflight fail-loud message → "Runtime binary failed to launch"', () => {
  // Exact string thrown by preflightRuntimeBinaries in profiles.js. This
  // is what main.js emits via runtime:error before spawn ever runs.
  const c = classify(
    'DSH runtime SDK not found at /Users/x/harness/dsh-demo-worktrees/deepseek-harness-dev/packages/examples/jsonrpc-demo/src/bin.ts. Set DSH_DEV_ROOT to your deepseek-harness checkout, or clone deepseek-harness as a sibling directory of dsh-desktop-demo.',
  )
  assert.equal(c.title, 'Runtime binary failed to launch')
  assert.match(c.hint, /DSH_DEV_ROOT/, 'hint must name the DSH_DEV_ROOT env override')
  assert.match(c.hint, /clone deepseek-harness/, 'hint must name the SDK checkout fix')
  assert.match(c.hint, /logs\/runtime-stderr\.log/, 'hint must name the log file path so users can attach it')
  assert.notEqual(c.title, 'Runtime file missing', 'must NOT fall into the generic ENOENT-file bucket')
})

test('Harness-dev-guard: real node `spawn <path> ENOENT` → "Runtime binary failed to launch"', () => {
  // Node emits exactly `spawn <path> ENOENT` for a missing binary
  // (verified against Node 24 / spawn a nonexistent .ts path). Anchoring
  // the shape lets the classifier bucket second-line-defend the preflight.
  const c = classify(
    'spawn /Users/x/harness/dsh-demo-worktrees/deepseek-harness-dev/packages/examples/jsonrpc-demo/src/bin.ts ENOENT',
  )
  assert.equal(c.title, 'Runtime binary failed to launch')
  assert.match(c.hint, /DSH_DEV_ROOT|deepseek-harness/, 'hint must point at the SDK checkout fix, not profile leaves')
  assert.notEqual(c.title, 'Runtime file missing', 'must NOT fall into the generic ENOENT-file bucket')
})

test('Harness-dev-guard: bare ENOENT (config file) still falls through to "Runtime file missing"', () => {
  // Defensive regression lock: the pre-existing generic bucket must
  // survive. A raw filesystem ENOENT on a config path should NOT be
  // misrouted to the spawn-failure bucket — the hint text there names
  // DSH_DEV_ROOT, which is not the right fix for a missing yml leaf.
  const c = classify('ENOENT: no such file or directory, open some/config.yml')
  assert.equal(c.title, 'Runtime file missing')
})

test('Harness-dev-guard: bucket lives BEFORE the generic ENOENT fallthrough in renderer source', () => {
  // Static ordering lock. If a future refactor moves the generic bucket
  // above the spawn-failure bucket, `spawn <path> ENOENT` would fall into
  // "Runtime file missing" first and never reach ours. Anchor the order.
  const src = fs.readFileSync(RENDERER_PATH, 'utf8')
  const spawnBucketIdx = src.indexOf('Runtime binary failed to launch')
  const genericIdx = src.indexOf("title: 'Runtime file missing'")
  assert.notEqual(spawnBucketIdx, -1, 'spawn-failure bucket not found in renderer.js')
  assert.notEqual(genericIdx, -1, 'generic ENOENT bucket not found in renderer.js')
  assert.ok(spawnBucketIdx < genericIdx, 'spawn-failure bucket must precede generic ENOENT bucket in source order')
})
