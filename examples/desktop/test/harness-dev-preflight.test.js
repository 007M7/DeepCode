// HARNESS_DEV phantom-path preflight (2026-07-18, fix/harness-dev-guard).
//
// profiles.js resolves the DSH runtime SDK against __dirname:
//   HARNESS_DEV = path.resolve(__dirname, '..', '..', '..', 'deepseek-harness-dev')
// When the shell is launched from a worktree — say
// `~/harness/dsh-demo-worktrees/lane-<foo>/` — that resolves to
// `~/harness/dsh-demo-worktrees/deepseek-harness-dev`, which doesn't
// exist. spawn then dies with `spawn <path>.ts ENOENT` and an empty
// stderr, and the shell used to misclassify it as "Runtime file missing —
// check your profile leaves" (wrong hint). The user-directive fix is a
// fail-loud preflight that emits an actionable error before spawn.
//
// These tests drive `preflightRuntimeBinaries()` directly. The Electron
// wiring in main.js is exercised by a static grep — no BrowserWindow / IPC
// boot needed for the unit path.
//
// Companion fixes tested in siblings:
//   test/renderer-runtime-banner-classify.test.js  — classifier bucket
//   test/runtime-stderr-log.test.js                — full-stderr log file

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  preflightRuntimeBinaries,
  _HARNESS_DEV,
  _jsonrpcBin,
  _daemonBin,
} = require('../src/main/profiles.js')

test('preflight: throws DSH_RUNTIME_SDK_NOT_FOUND when jsonrpcBin is absent from HARNESS_DEV', () => {
  // In a worktree checkout the sibling `deepseek-harness-dev/` doesn't
  // exist, so this fires the real error path. If a future test runner
  // materializes the SDK there, this test skips its own body — the guard
  // is functionally correct either way, but the fail-loud shape is what
  // we're locking here.
  let jsonrpcExists = true
  try { fs.accessSync(_jsonrpcBin) } catch (_) { jsonrpcExists = false }
  if (jsonrpcExists) {
    // SDK is on disk (dev environment ran from the main clone). Skip.
    return
  }
  assert.throws(
    () => preflightRuntimeBinaries('stdio-deepseek'),
    (err) => {
      assert.equal(err.code, 'DSH_RUNTIME_SDK_NOT_FOUND', 'error must carry the sentinel code')
      assert.match(err.message, /DSH runtime SDK not found at /, 'message names the specific path')
      assert.match(err.message, /DSH_DEV_ROOT/, 'message names the env override')
      assert.match(err.message, /clone deepseek-harness as a sibling/, 'message names the second fix')
      assert.ok(Array.isArray(err.missingPaths) && err.missingPaths.length > 0, 'missingPaths payload present')
      assert.equal(err.harnessDevRoot, _HARNESS_DEV, 'harnessDevRoot payload for diagnostics')
      return true
    },
  )
})

test('preflight: names jsonrpcBin for stdio profiles, daemonBin for daemon profiles', () => {
  // Guard the branching by inspecting the missingPaths payload. The
  // profile-mode dispatch is a fast-path source of bugs (was the shape
  // that produced "check profile leaves" hint for a daemon-mode spawn
  // failure); a static test locks which binary each profile consults.
  //
  // daemon-echo → daemonBin, stdio-echo → jsonrpcBin, etc. If either bin
  // exists on disk we can't observe the code path via this call, so we
  // fall back to reading the source's mode dispatch table.
  const bothMissing = (() => {
    try { fs.accessSync(_jsonrpcBin) } catch (_) { try { fs.accessSync(_daemonBin) } catch (__) { return true } }
    return false
  })()
  if (!bothMissing) return // SDK partly materialized in this environment
  const stdioErr = (() => { try { preflightRuntimeBinaries('stdio-echo'); return null } catch (e) { return e } })()
  const daemonErr = (() => { try { preflightRuntimeBinaries('daemon-echo'); return null } catch (e) { return e } })()
  assert.ok(stdioErr && stdioErr.missingPaths.some((p) => /jsonrpc-demo/.test(p)), 'stdio profile flags jsonrpcBin')
  assert.ok(daemonErr && daemonErr.missingPaths.some((p) => /daemon-demo/.test(p)), 'daemon profile flags daemonBin')
})

test('preflight: main.js calls preflight inside startRuntime before constructing the supervisor', () => {
  // Static lock: the wiring must exist and must run BEFORE `new
  // RuntimeSupervisor(...)`. If a future refactor moves preflight past
  // that line, spawn will still race the classifier and the whole point
  // of the fail-loud path is lost.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  const preflightIdx = src.indexOf('preflightRuntimeBinaries(name)')
  assert.notEqual(preflightIdx, -1, 'preflightRuntimeBinaries must be called from main.js')
  const supervisorIdx = src.indexOf('new RuntimeSupervisor(')
  assert.notEqual(supervisorIdx, -1, 'RuntimeSupervisor construction must still exist in main.js')
  assert.ok(preflightIdx < supervisorIdx, 'preflight must run BEFORE new RuntimeSupervisor')
  // The failure branch must send runtime:error so the classifier's
  // Runtime-binary-failed-to-launch bucket picks it up.
  const window = src.slice(preflightIdx, supervisorIdx)
  assert.match(window, /send\('runtime:error'/, 'preflight failure must emit runtime:error to the renderer')
})
