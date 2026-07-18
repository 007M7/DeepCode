// Isolated daemon helper: spawn a dsh-daemon-demo process against a caller-
// supplied overlay (or base leaf), on a caller-supplied temp dir. Used by:
//
//   - the plugin Playground (B): a scratch runtime the user can drive without
//     touching their live daemon or sessions history;
//   - the startup-probe layer (A2): a short-lived process that we boot,
//     wait-for-ping-or-fail, capture stderr, and tear down.
//
// The two use cases share:
//   - a per-instance runtime dir with `daemon.sock`, `daemon.lock`, `sessions/`
//     (short paths — unix socket budget is ~104 bytes);
//   - the same tsx-loader argv + env layout profiles.js already uses for the
//     main daemon;
//   - the same `SIGTERM → SIGKILL after 1.5s` teardown chain.
//
// What they don't share: the main daemon's respawn+backoff behaviour. An
// isolated daemon is deliberately one-shot; if it dies, the caller decides
// what to do (playground → surface a crash card, probe → treat as failure).

'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { probeDaemon, waitForSocket } = require('./daemon.js')

const PROBE_ATTEMPTS = 8
const PROBE_INTERVAL_MS = 250

/**
 * Build the env dict handed to the isolated daemon child. Split out from the
 * spawn call so a unit test can assert the plumbing without booting a real
 * daemon.
 *
 * `ELECTRON_RUN_AS_NODE: '1'` is mandatory under `pnpm start` because
 * `process.execPath` is the Electron binary — without this env var Electron
 * treats `--import <tsxSpecifier> <daemonBin>` as an app path and silent-exits
 * before the socket is bound (regression: playground boot failed with
 * "isolated daemon socket did not appear"; profiles.js:79 solves the same
 * problem for the main daemon). Harmless under real node.
 */
function buildIsolatedDaemonEnv(spec) {
  const { tsxTsconfigPath, runtime, extraEnv } = spec
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TSX_TSCONFIG_PATH: tsxTsconfigPath,
    DSH_DAEMON_SOCKET_PATH: runtime.socketPath,
    DSH_DAEMON_LOCKFILE_PATH: runtime.lockfilePath,
    DSH_DAEMON_SESSIONS_ROOT: runtime.sessionsRoot,
    ...(extraEnv || {}),
  }
}

/**
 * Materialise a per-instance runtime dir under `os.tmpdir()`. Directory name
 * carries `purpose` for QA-friendly ls output.
 */
function makeRuntimeDir(purpose) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-desktop-${purpose}-`))
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  return {
    dir,
    socketPath: path.join(dir, 'daemon.sock'),
    lockfilePath: path.join(dir, 'daemon.lock'),
    sessionsRoot: path.join(dir, 'sessions'),
  }
}

/**
 * Spawn a daemon-demo process against `overlayOrLeafPath`, wait for its ping
 * to return, and hand back `{ child, socketPath, ..., dispose() }`. `dispose`
 * is idempotent: SIGTERM → SIGKILL after `killGraceMs`, then remove the
 * runtime dir. On probe failure the child is killed and the temp dir is
 * cleaned up before the returned promise rejects.
 *
 * @param {{
 *   overlayOrLeafPath: string,        // absolute path to a cordis.yml leaf
 *   daemonBin: string,                // absolute path to daemon bin (tsx-loaded)
 *   tsxSpecifier: string,             // resolved tsx package specifier
 *   tsxTsconfigPath: string,          // absolute tsconfig for tsx loader
 *   cwd?: string,                     // defaults to the runtime dir
 *   extraEnv?: Record<string,string>, // additional env vars
 *   purpose?: string,                 // 'playground' | 'probe' | …
 *   killGraceMs?: number,             // default 1500ms
 *   probeAttempts?: number,           // default PROBE_ATTEMPTS
 * }} spec
 * @returns {Promise<{
 *   child: import('node:child_process').ChildProcess,
 *   runtimeDir: string,
 *   socketPath: string,
 *   lockfilePath: string,
 *   sessionsRoot: string,
 *   pingResult: unknown,
 *   dispose(): Promise<void>,
 * }>}
 */
async function spawnIsolatedDaemon(spec) {
  const {
    overlayOrLeafPath,
    daemonBin,
    tsxSpecifier,
    tsxTsconfigPath,
    cwd,
    extraEnv,
    purpose = 'iso',
    killGraceMs = 1500,
    probeAttempts = PROBE_ATTEMPTS,
  } = spec
  if (!overlayOrLeafPath || !daemonBin) {
    throw new Error('spawnIsolatedDaemon: overlayOrLeafPath and daemonBin required')
  }
  const rt = makeRuntimeDir(purpose)
  const stderrBuf = []
  const args = tsxSpecifier
    ? ['--import', tsxSpecifier, daemonBin, overlayOrLeafPath]
    : [daemonBin, overlayOrLeafPath]
  const child = spawn(process.execPath, args, {
    cwd: cwd || rt.dir,
    env: buildIsolatedDaemonEnv({ tsxTsconfigPath, runtime: rt, extraEnv }),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  })
  child.stdout.on('data', () => { /* daemon has no stdout protocol */ })
  child.stderr.on('data', (chunk) => {
    // Keep the last ~8KB — enough for a fail-loud stack, small enough not
    // to bloat memory if a probe is left running by accident.
    const s = chunk.toString('utf8')
    stderrBuf.push(s)
    let total = 0
    for (let i = stderrBuf.length - 1; i >= 0; i--) {
      total += stderrBuf[i].length
      if (total > 8192) { stderrBuf.splice(0, i); break }
    }
  })

  // Watch for early exit; if the child dies before ping succeeds, reject.
  let exited = false
  const exitInfo = {}
  child.on('exit', (code, signal) => {
    exited = true
    exitInfo.code = code
    exitInfo.signal = signal
  })

  let disposed = false
  async function dispose() {
    if (disposed) return
    disposed = true
    try {
      if (child && !exited && child.pid) child.kill('SIGTERM')
    } catch (_) { /* already dying */ }
    if (child && !exited) {
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        new Promise((r) => setTimeout(r, killGraceMs)),
      ])
      if (!exited) {
        try { child.kill('SIGKILL') } catch (_) { /* gone */ }
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    // Best-effort dir cleanup; a stuck socket or lockfile handled by the
    // OS on the next boot.
    try { fs.rmSync(rt.dir, { recursive: true, force: true }) } catch (_) {}
  }

  try {
    // Two-stage wait: socket file appearance, then ping.
    const appeared = await waitForSocket(rt.socketPath, 4000)
    if (!appeared) {
      await dispose()
      const err = new Error(`isolated daemon socket did not appear at ${rt.socketPath}`)
      err.stderrTail = stderrBuf.join('').slice(-4096)
      err.exit = { ...exitInfo }
      throw err
    }
    let ping = null
    for (let i = 0; i < probeAttempts; i++) {
      if (exited) break
      ping = await probeDaemon(rt.socketPath)
      if (ping) break
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
    }
    if (!ping) {
      await dispose()
      const err = new Error(`isolated daemon did not answer ping within ${probeAttempts * PROBE_INTERVAL_MS}ms`)
      err.stderrTail = stderrBuf.join('').slice(-4096)
      err.exit = { ...exitInfo }
      throw err
    }
    return {
      child,
      runtimeDir: rt.dir,
      socketPath: rt.socketPath,
      lockfilePath: rt.lockfilePath,
      sessionsRoot: rt.sessionsRoot,
      pingResult: ping,
      stderrTail: () => stderrBuf.join(''),
      dispose,
    }
  } catch (err) {
    // ensure the promise rejects with the stderr context.
    await dispose().catch(() => {})
    throw err
  }
}

module.exports = { spawnIsolatedDaemon, makeRuntimeDir, buildIsolatedDaemonEnv }
