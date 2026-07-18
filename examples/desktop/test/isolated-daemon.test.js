// Unit tests for src/main/isolated-daemon.js. We test the pure directory-
// materialisation helper here; the full spawn path is covered by the manual
// verification script in README (booting a real daemon in <2s isn't reliable
// in a unit-test loop, and the module composes over daemon.js which already
// has its own coverage).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const M = require('../src/main/isolated-daemon.js')

test('makeRuntimeDir creates a unique dir with socket/lock/sessions paths', () => {
  const a = M.makeRuntimeDir('unit')
  const b = M.makeRuntimeDir('unit')
  try {
    assert.notEqual(a.dir, b.dir)
    assert.ok(fs.existsSync(a.dir))
    assert.ok(fs.existsSync(path.join(a.dir, 'sessions')))
    assert.equal(a.socketPath, path.join(a.dir, 'daemon.sock'))
    assert.equal(a.lockfilePath, path.join(a.dir, 'daemon.lock'))
    assert.equal(a.sessionsRoot, path.join(a.dir, 'sessions'))
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true })
    fs.rmSync(b.dir, { recursive: true, force: true })
  }
})

test('spawnIsolatedDaemon rejects when required args are missing', async () => {
  await assert.rejects(() => M.spawnIsolatedDaemon({ daemonBin: '/x' }), /required/)
  await assert.rejects(() => M.spawnIsolatedDaemon({ overlayOrLeafPath: '/x' }), /required/)
})

test('buildIsolatedDaemonEnv sets ELECTRON_RUN_AS_NODE=1 so Electron does not swallow --import tsx', () => {
  // Regression guard for task #153: playground boot silently failed under
  // `pnpm start` because Electron treats `--import <tsx> <daemonBin>` as an
  // app path unless this env var is set. profiles.js:79 solves the same
  // problem for the main daemon; this test locks the isolated path in.
  const env = M.buildIsolatedDaemonEnv({
    tsxTsconfigPath: '/harness/tsconfig.json',
    runtime: {
      socketPath: '/tmp/x/daemon.sock',
      lockfilePath: '/tmp/x/daemon.lock',
      sessionsRoot: '/tmp/x/sessions',
    },
  })
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.TSX_TSCONFIG_PATH, '/harness/tsconfig.json')
  assert.equal(env.DSH_DAEMON_SOCKET_PATH, '/tmp/x/daemon.sock')
  assert.equal(env.DSH_DAEMON_LOCKFILE_PATH, '/tmp/x/daemon.lock')
  assert.equal(env.DSH_DAEMON_SESSIONS_ROOT, '/tmp/x/sessions')
})

test('buildIsolatedDaemonEnv inherits process.env and merges extraEnv last', () => {
  const env = M.buildIsolatedDaemonEnv({
    tsxTsconfigPath: '/t',
    runtime: { socketPath: '/s', lockfilePath: '/l', sessionsRoot: '/r' },
    extraEnv: { DEEPSEEK_API_KEY: 'sk-test', TSX_TSCONFIG_PATH: '/override' },
  })
  // process.env inheritance is proven via PATH (present on every platform we run on).
  assert.equal(typeof env.PATH, 'string')
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-test')
  // extraEnv overrides the defaults (spread order).
  assert.equal(env.TSX_TSCONFIG_PATH, '/override')
  // But not ELECTRON_RUN_AS_NODE — callers should not need to know about this env var.
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
})
