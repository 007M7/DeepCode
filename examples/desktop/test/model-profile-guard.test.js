// model-profile-guard.test.js — Preflight (2026-07-18) P0 fix.
//
// User hit `session finished (error): no adapter registered for model
// "deepseek-v4-flash" [NO_ADAPTER]` on every send because the composer
// dropdown listed a global KNOWN_MODELS array unrelated to which
// adapters the active profile actually registered. This suite locks:
//
//   1. profiles.js:PROFILE_MODELS matches each yml leaf's `models:` block
//      (source of truth) — and modelsFor() reflects it.
//   2. main.js exports the supportedModels list on runtime:status AND
//      through the new `profiles:models` IPC handler.
//   3. preload exposes profilesModels().
//   4. renderer.js:renderComposerModel filters against
//      supportedModelsForActive and paints the muted advisory when the
//      selected model isn't hosted.
//   5. renderer.js:applyNoAdapterHint appends a plain-English tip on top
//      of the raw wire error, folds ≥2 repeats to `×N`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const profiles = require(path.join(ROOT, 'src/main/profiles.js'))
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8')
const indexHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')
const styleCss = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8')

// ---------- (1) PROFILE_MODELS source of truth ---------------------------

test('modelsFor: echo-family profiles register only mock-echo', () => {
  assert.deepEqual(profiles.modelsFor('daemon-echo'), ['mock-echo'])
  assert.deepEqual(profiles.modelsFor('stdio-echo'), ['mock-echo'])
  assert.deepEqual(profiles.modelsFor('daemon-vibe-echo'), ['mock-echo'])
})

test('modelsFor: deepseek-jsonrpc registers v4-flash and v4-pro (flash first)', () => {
  assert.deepEqual(profiles.modelsFor('stdio-deepseek'), ['deepseek-v4-flash', 'deepseek-v4-pro'])
})

test('modelsFor: vibe-deepseek registers v4-pro and v4-flash (pro first)', () => {
  assert.deepEqual(profiles.modelsFor('stdio-vibe-deepseek'), ['deepseek-v4-pro', 'deepseek-v4-flash'])
})

test('modelsFor: unknown profile returns an empty array (never throws)', () => {
  assert.deepEqual(profiles.modelsFor('no-such-profile'), [])
  assert.deepEqual(profiles.modelsFor(undefined), [])
})

test('modelsFor: every listProfiles entry has a non-empty models list', () => {
  for (const name of profiles.listProfiles()) {
    const list = profiles.modelsFor(name)
    assert.ok(Array.isArray(list) && list.length > 0,
      `profile "${name}" must declare at least one model (found ${JSON.stringify(list)})`)
  }
})

test('modelsFor: the profile default model IS in its supported list (no self-mismatch)', () => {
  for (const name of profiles.listProfiles()) {
    const p = profiles.profile(name)
    const supported = profiles.modelsFor(name)
    assert.ok(supported.includes(p.model),
      `profile "${name}" default model "${p.model}" is not in its own supported list ${JSON.stringify(supported)}`)
  }
})

// Source-of-truth check: PROFILE_MODELS mirrors each yml leaf's `models:`
// block, so a future yaml edit that adds/removes a model can't drift
// silently. We parse the yaml the shell-way — one leaf per profile — and
// compare the `models:` list line-by-line.
test('PROFILE_MODELS: each entry matches its yml leaf models: block', () => {
  const leafFor = {
    'daemon-echo': null,           // mock-llm — no models: block in yaml, always mock-echo
    'stdio-echo': null,            // mock-llm — ditto
    'daemon-vibe-echo': null,      // mock-llm — ditto
    'stdio-deepseek': path.join(ROOT, 'config/deepseek-jsonrpc.yml'),
    'stdio-vibe-deepseek': path.join(ROOT, 'config/deepseek-vibe.yml'),
  }
  for (const [profileName, leafPath] of Object.entries(leafFor)) {
    const expected = profiles.modelsFor(profileName)
    if (!leafPath) {
      // Mock-llm profiles: the mock-llm adapter hardcodes `mock-echo`;
      // PROFILE_MODELS just has to say so.
      assert.deepEqual(expected, ['mock-echo'],
        `${profileName}: mock-llm profile must only list mock-echo`)
      continue
    }
    const yaml = fs.readFileSync(leafPath, 'utf8')
    // Find the `models:` block under `llm-deepseek` and collect its
    // `- <name>` entries. The block is 6-space-indented, sits inside a
    // `config:` map, and terminates when the indent drops back to a
    // 2-space `- id:` list item. Bail early at the first line whose
    // trim doesn't start with `- ` after the models: header.
    const lines = yaml.split('\n')
    let inBlock = false
    const yamlModels = []
    for (const rawLine of lines) {
      if (!inBlock) {
        if (/^\s+models:\s*$/.test(rawLine)) { inBlock = true; continue }
        continue
      }
      // Inside the block: entries look like `      - deepseek-v4-flash`.
      const m = /^\s+-\s+([\w-]+)\s*$/.exec(rawLine)
      if (m) { yamlModels.push(m[1]); continue }
      // Any other non-empty line terminates the block.
      if (rawLine.trim() !== '') break
    }
    assert.ok(yamlModels.length > 0, `${leafPath}: parsed empty models: block`)
    assert.deepEqual(expected.slice().sort(), yamlModels.slice().sort(),
      `${profileName} PROFILE_MODELS drift vs ${path.basename(leafPath)}: expected ${JSON.stringify(yamlModels)}, got ${JSON.stringify(expected)}`)
  }
})

// ---------- (2) main.js: status + IPC ------------------------------------

test('main: startRuntime emits supportedModels on runtime:status', () => {
  assert.match(mainSrc, /supportedModels:\s*modelsFor\(name\)/)
})

test('main: runtime:status handler includes supportedModels', () => {
  // Match the whole runtime:status object; the block should reference
  // `currentProfileName ? modelsFor(currentProfileName) : []`.
  assert.match(mainSrc, /supportedModels:\s*currentProfileName\s*\?\s*modelsFor\(currentProfileName\)\s*:\s*\[\]/)
})

test('main: profiles:models IPC handler is registered', () => {
  assert.match(mainSrc, /ipcMain\.handle\('profiles:models',/)
  assert.match(mainSrc, /activeProfile:\s*currentProfileName,\s*models:\s*map/)
})

test('main: modelsFor is imported from profiles', () => {
  // Loosened (2026-07-18, fix/harness-dev-guard): the destructure gained
  // `preflightRuntimeBinaries` for the phantom-path guard, and future
  // additions will likely keep piling on. The invariant we care about is
  // "profile, listProfiles, modelsFor are all imported from profiles.js"
  // — order/adjacency doesn't matter. Anchor each name individually.
  const destructureMatch = mainSrc.match(/const\s*\{\s*([^}]+)\s*\}\s*=\s*require\('\.\/profiles\.js'\)/)
  assert.notEqual(destructureMatch, null, 'a destructured require of ./profiles.js must exist')
  const names = destructureMatch[1].split(',').map((s) => s.trim())
  assert.ok(names.includes('profile'), 'profile must be imported from ./profiles.js')
  assert.ok(names.includes('listProfiles'), 'listProfiles must be imported from ./profiles.js')
  assert.ok(names.includes('modelsFor'), 'modelsFor must be imported from ./profiles.js')
})

// ---------- (3) preload exposes profilesModels ---------------------------

test('preload: profilesModels() bridges profiles:models', () => {
  assert.match(preloadSrc, /profilesModels:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('profiles:models'\)/)
})

// ---------- (4) renderer: dropdown filter + advisory ----------------------

test('renderer: KNOWN_MODELS retained as boot-fallback list', () => {
  // We keep the union list for the pre-status renderer boot. Regression
  // if someone removes it thinking the profile map fully replaces it.
  assert.match(rendererSrc, /const KNOWN_MODELS = \[/)
  assert.match(rendererSrc, /value:\s*'mock-echo'/)
  assert.match(rendererSrc, /value:\s*'deepseek-v4-flash'/)
  assert.match(rendererSrc, /value:\s*'deepseek-v4-pro'/)
})

test('renderer: supportedModelsForActive state tracks per-profile list', () => {
  assert.match(rendererSrc, /let supportedModelsForActive\s*=\s*null/)
})

test('renderer: renderComposerModel filters by supportedModelsForActive', () => {
  // The filter branch must exist AND use supportedModelsForActive when
  // known (not the static KNOWN_MODELS list unconditionally).
  assert.match(rendererSrc,
    /const supported\s*=\s*Array\.isArray\(supportedModelsForActive\)[\s\S]{0,200}:\s*KNOWN_MODELS\.map\(\(m\)\s*=>\s*m\.value\)/)
  assert.match(rendererSrc, /for \(const value of supported\) \{/)
})

test('renderer: renderComposerModel anchors unsupported current selection with "· unsupported"', () => {
  assert.match(rendererSrc, /\$\{current\} · unsupported/)
  assert.match(rendererSrc, /opt\.dataset\.unsupported = '1'/)
})

test('renderer: composer-model-warn advisory names the target profile', () => {
  assert.match(rendererSrc, /const target = profileHosting\(current\)/)
  assert.match(rendererSrc, /isn't wired under \$\{activeLabel\}/)
  assert.match(rendererSrc, /switch to \$\{target\}/)
})

test('renderer: onStatus updates activeProfileName and supportedModelsForActive', () => {
  assert.match(rendererSrc,
    /window\.dsh\.onStatus\(\(\{ status, profile, model, supportedModels \}\)/)
  assert.match(rendererSrc, /supportedModelsForActive\s*=\s*supportedModels\.slice\(\)/)
})

test('renderer: bootUi hydrates profileModelsMap via profilesModels()', () => {
  assert.match(rendererSrc, /await window\.dsh\.profilesModels\(\)/)
  assert.match(rendererSrc, /profileModelsMap = pm\.models/)
})

test('renderer: profileHosting prefers the profile that lists it first (index 0)', () => {
  // Contract test — the helper's ordering rule must survive refactors.
  assert.match(rendererSrc, /if \(idx === 0\) return pname/)
  assert.match(rendererSrc, /if \(idx > 0 && !fallback\) fallback = pname/)
})

// ---------- (5) NO_ADAPTER friendly hint + fold ---------------------------

test('renderer: applyNoAdapterHint matches the wire text OR code', () => {
  assert.match(rendererSrc, /\/no adapter registered\/i\.test\(msg\)/)
  assert.match(rendererSrc, /reason\.code === 'NO_ADAPTER'/)
})

test('renderer: applyNoAdapterHint parses the model name from the wire message', () => {
  assert.match(rendererSrc, /\/model\\s\+"\(\[\^"\]\+\)"\/i\.exec\(msg\)/)
})

test('renderer: applyNoAdapterHint appends a muted Tip line pointing to a target profile when known', () => {
  assert.match(rendererSrc, /Switch to profile "\$\{target\}"/)
  assert.match(rendererSrc, /pick a supported model in the composer/)
})

test('renderer: appendSystemDetailFolded collapses identical repeat lines into ×N', () => {
  assert.match(rendererSrc, /function appendSystemDetailFolded/)
  assert.match(rendererSrc, /last\.dataset\.foldKey === `\$\{severity\}\\n\$\{text\}`/)
  assert.match(rendererSrc, /last\.textContent = `\$\{text\} ×\$\{n\}`/)
})

test('renderer: session.finished path uses appendSystemDetailFolded (folded on repeat)', () => {
  // The single-fold call within the session.finished branch is the load-
  // bearing wire-up. Match the exact call site so a future edit that
  // reverts to appendSystemDetail breaks this test.
  assert.match(rendererSrc,
    /finishedEl = appendSystemDetailFolded\(spec\.line, \{ title: spec\.title, severity: spec\.severity \}\)/)
})

test('renderer: session.finished path invokes applyNoAdapterHint after paint', () => {
  assert.match(rendererSrc, /void applyNoAdapterHint\(params, finishedEl\)/)
})

test('renderer: applyNoAdapterHint marks the finished row with data-no-adapter', () => {
  assert.match(rendererSrc, /priorEl\.dataset\.noAdapter = '1'/)
})

// ---------- (6) DOM + CSS ------------------------------------------------

test('index.html: composer-model-warn advisory element is present', () => {
  assert.match(indexHtml, /<div id="composer-model-warn"/)
  assert.match(indexHtml, /class="composer-model-warn"/)
  assert.match(indexHtml, /aria-live="polite"/)
})

test('style.css: .composer-model-warn is styled as muted advisory (warn accent, warn-soft bg)', () => {
  assert.match(styleCss, /\.composer-model-warn\s*\{/)
  assert.match(styleCss, /border-left:\s*2px solid var\(--warn\)/)
  assert.match(styleCss, /background:\s*var\(--warn-soft\)/)
})

// ---------- (7) Behaviour: profileHosting logic (extracted regression) ---
//
// The helper is defined at module top level in renderer.js; extract it via
// a minimal jsdom-free eval so we can hit its edge cases without booting
// a full DOM harness. This keeps the guard behavioural, not just
// fingerprint-based.

function extractProfileHosting() {
  // Locate the function source and evaluate a self-contained closure
  // that exposes it against a controllable profileModelsMap. Cheap and
  // pinned to the on-disk source.
  const match = /function profileHosting\(wanted\) \{[\s\S]+?\n\}/.exec(rendererSrc)
  if (!match) throw new Error('profileHosting source not found')
  // eslint-disable-next-line no-new-func
  const factory = new Function('map',
    'let profileModelsMap = map;\n' + match[0] + '\nreturn profileHosting;')
  return factory
}

test('profileHosting: prefers the profile listing it as default (index 0)', () => {
  const factory = extractProfileHosting()
  const host = factory({
    'stdio-deepseek': ['deepseek-v4-flash', 'deepseek-v4-pro'],
    'stdio-vibe-deepseek': ['deepseek-v4-pro', 'deepseek-v4-flash'],
  })
  // v4-flash is at index 0 in stdio-deepseek; must win.
  assert.equal(host('deepseek-v4-flash'), 'stdio-deepseek')
  // v4-pro is at index 0 in stdio-vibe-deepseek; must win.
  assert.equal(host('deepseek-v4-pro'), 'stdio-vibe-deepseek')
})

test('profileHosting: falls back to non-default-index when no profile has it at 0', () => {
  const factory = extractProfileHosting()
  const host = factory({
    'p-a': ['foo', 'target'],
    'p-b': ['bar', 'baz'],
  })
  assert.equal(host('target'), 'p-a')
})

test('profileHosting: returns null when no profile hosts the model', () => {
  const factory = extractProfileHosting()
  const host = factory({ 'p-a': ['foo'], 'p-b': ['bar'] })
  assert.equal(host('xyz'), null)
})

test('profileHosting: returns null when profileModelsMap is not yet hydrated', () => {
  const factory = extractProfileHosting()
  const host = factory(null)
  assert.equal(host('deepseek-v4-flash'), null)
})
