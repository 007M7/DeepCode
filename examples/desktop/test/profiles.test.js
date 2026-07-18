// Unit tests for src/main/profiles.js — targeted at leafPathFor, the seam
// the Plugins tab reads to answer "which yaml is this profile actually
// booting from?". The previous behavior hardcoded daemon-echo.yml under
// activeBasePath() in main.js, so the Plugins tab under stdio-deepseek
// showed the wrong leaf and the runtime fold reconciled against noise.
// QA round-3 shot 07 (2026-07-16) caught the regression; team-lead
// asked for a pin here so switching the leaf mapping later can't drift
// silently.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const { profile, listProfiles, leafPathFor, PROFILE_LEAF, configDir } = require('../src/main/profiles.js')

test('leafPathFor returns the profile-specific yaml leaf', () => {
  assert.strictEqual(path.basename(leafPathFor('daemon-echo')), 'daemon-echo.yml')
  assert.strictEqual(path.basename(leafPathFor('stdio-echo')), 'echo-jsonrpc.yml')
  assert.strictEqual(path.basename(leafPathFor('stdio-deepseek')), 'deepseek-jsonrpc.yml')
  assert.strictEqual(path.basename(leafPathFor('daemon-vibe-echo')), 'daemon-vibe.yml')
  assert.strictEqual(path.basename(leafPathFor('stdio-vibe-deepseek')), 'deepseek-vibe.yml')
})

test('leafPathFor throws for an unknown profile (fail-loud rather than default)', () => {
  // Silent-default to daemon-echo.yml was the shape that caused the shot-07
  // bug. Locking the error path here so a typo in a future call site never
  // slips back into that behavior.
  assert.throws(() => leafPathFor('nope'), /unknown profile/)
  assert.throws(() => leafPathFor(''), /unknown profile/)
  assert.throws(() => leafPathFor(undefined), /unknown profile/)
})

test('leafPathFor covers every id in listProfiles()', () => {
  // If listProfiles adds a new entry (a future desktop-web profile, say),
  // the map must gain the corresponding leaf too. This test fails until
  // that happens.
  for (const name of listProfiles()) {
    assert.doesNotThrow(() => leafPathFor(name), `missing leaf for profile ${name}`)
  }
})

test('every mapped leaf exists on disk under config/', () => {
  for (const [name, leaf] of Object.entries(PROFILE_LEAF)) {
    const full = path.join(configDir, leaf)
    assert.ok(
      fs.existsSync(full),
      `config leaf missing for profile "${name}": ${full}. Either add the leaf, ` +
        `rename it in profiles.js, or drop the profile from listProfiles.`,
    )
  }
})

test('profile() surfaces leafName matching leafPathFor', () => {
  // The leafName field on the profile object is what other main-side
  // callers can inspect without dipping into PROFILE_LEAF (e.g. a probe
  // handler that wants "the leaf this profile boots from" without
  // reparsing spawn argv).
  for (const name of listProfiles()) {
    const p = profile(name)
    assert.strictEqual(
      p.leafName,
      PROFILE_LEAF[name],
      `profile(${name}).leafName should be "${PROFILE_LEAF[name]}"`,
    )
    assert.strictEqual(
      path.join(configDir, p.leafName),
      leafPathFor(name),
      'leafName + configDir should equal leafPathFor()',
    )
  }
})

test('profile() spawn args reference the profile-specific leaf', () => {
  // Regression pin: daemon-echo boots resolveDaemonLeaf (overlay-aware),
  // every other profile embeds its own config path. If someone hardcodes
  // daemon-echo.yml into another profile's args, this catches it.
  const stdioDeepseek = profile('stdio-deepseek')
  const lastArg = stdioDeepseek.args[stdioDeepseek.args.length - 1]
  assert.match(lastArg, /deepseek-jsonrpc\.yml$/)
  assert.doesNotMatch(lastArg, /daemon-echo\.yml$/)

  const stdioEcho = profile('stdio-echo')
  const echoArg = stdioEcho.args[stdioEcho.args.length - 1]
  assert.match(echoArg, /echo-jsonrpc\.yml$/)
  assert.doesNotMatch(echoArg, /daemon-echo\.yml$/)
})
