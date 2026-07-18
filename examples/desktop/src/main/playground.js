// Plugin Playground: a scratch runtime the user can drive against a proposed
// overlay without touching the live daemon or their sessions history.
//
// Architecture (B1-B3):
//   - The Plugins tab writes a scratch overlay (a full copy of the current
//     user-overlay, edited via the tab in playground mode) into a temp dir.
//   - We boot an *isolated* daemon over `spawnIsolatedDaemon(overlay, tmp)`
//     — separate socket, separate `.sessions/` dir, no relation to the live
//     daemon.
//   - A dedicated `RuntimeSupervisor` connects to that daemon; the renderer
//     drives it via a small IPC surface (`playground:new`, `playground:prompt`,
//     `playground:events`, `playground:cancel`, `playground:notify`) that
//     mirrors the main session IPCs but stays on a distinct channel so a
//     playground notify never gets confused with a live-runtime notify.
//   - Two commit actions:
//       * `playground:apply` — copy the scratch overlay over the live
//         `user-overlay.cordis.yml`, then restart the main runtime.
//       * `playground:discard` — stop the isolated daemon, delete the
//         temp dir. Zero residue.
//
// The isolated daemon speaks the same protocol v2 the main one does, so the
// renderer can re-use the chat pane. The banner + the dedicated IPC channel
// are the only UX differences.
//
// B4 (history-compare) sits on top of this: the renderer picks a session
// from the live runtime, extracts the first user message, and re-sends it
// via `playground:prompt`. The two streams paint side by side. We don't
// re-fork the live session's transcript — that needs `session/fork` on the
// wire — but the "same question, new plugin set" comparison is the 80%
// use case per the team-lead brief.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { RuntimeSupervisor } = require('./runtime.js')
const { spawnIsolatedDaemon } = require('./isolated-daemon.js')

class PlaygroundSession {
  /**
   * @param {{
   *   scratchOverlayPath: string,
   *   scratchDir: string,
   *   isolated: import('./isolated-daemon.js').spawnIsolatedDaemon extends (...args:any)=>infer R ? Awaited<R> : never,
   *   supervisor: RuntimeSupervisor,
   *   profile: object,
   *   originalBaseRef: string,
   * }} bits
   */
  constructor(bits) {
    this.scratchOverlayPath = bits.scratchOverlayPath
    this.scratchDir = bits.scratchDir
    this.isolated = bits.isolated
    this.supervisor = bits.supervisor
    this.profile = bits.profile
    // The base-ref value in the LIVE overlay's `path:` field. Kept so the
    // apply path can rewrite scratch's absolute path back to the original
    // relative value before copying scratch bytes over the live file.
    this.originalBaseRef = bits.originalBaseRef
    // Sessions minted inside this playground. We track them so the discard
    // path can offer per-session cancels before killing the daemon.
    this.sessions = new Set()
  }
}

/**
 * Build a playground bound to a scratch copy of the current user overlay.
 *
 * @param {{
 *   liveOverlayPath: string,       // ~/.dsh-desktop/user-overlay.cordis.yml
 *   baseLeafPath: string,          // absolute path to daemon-echo.yml (the leaf the overlay includes)
 *   daemonBin: string,             // absolute path to daemon bin
 *   tsxSpecifier: string,
 *   tsxTsconfigPath: string,
 *   onNotify: (method:string, params:unknown) => void,
 *   onStatus: (status:string) => void,
 *   onCrash: (info:unknown) => void,
 *   onStderr?: (chunk:string) => void,
 *   onInterrupt?: (request:unknown) => Promise<unknown>,
 * }} spec
 * @returns {Promise<PlaygroundSession>}
 */
async function startPlayground(spec) {
  const {
    liveOverlayPath, baseLeafPath, daemonBin, tsxSpecifier, tsxTsconfigPath,
    onNotify, onStatus, onCrash, onStderr, onInterrupt,
  } = spec
  if (!liveOverlayPath || !baseLeafPath || !daemonBin) {
    throw new Error('startPlayground: liveOverlayPath, baseLeafPath, daemonBin required')
  }
  // Materialise scratch: a temp dir with a copy of the overlay. The overlay's
  // `path:` field is rewritten to the ABSOLUTE base leaf path so the scratch
  // dir doesn't need a sibling copy of the leaf. Apply reverses this: rewrite
  // `path:` back to the original (relative) value before copying scratch over
  // the live overlay.
  const scratchDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsh-desktop-playground-'))
  const scratchOverlay = path.join(scratchDir, 'user-overlay.cordis.yml')
  // Original base-ref text for the apply-back path. If there's no live
  // overlay, we synthesize one that includes the base by absolute path;
  // apply then writes the same absolute value.
  let originalBaseRef
  if (fs.existsSync(liveOverlayPath)) {
    const overlayText = fs.readFileSync(liveOverlayPath, 'utf8')
    const m = overlayText.match(/^(\s+path:\s*)(.+)$/m)
    originalBaseRef = m ? m[2].trim().replace(/^['"]|['"]$/g, '') : baseLeafPath
    // Rewrite `path:` to absolute so the scratch daemon can load without
    // a sibling base copy.
    const rewritten = overlayText.replace(
      /^(\s+path:\s*).+$/m,
      (_match, prefix) => `${prefix}${JSON.stringify(baseLeafPath)}`,
    )
    fs.writeFileSync(scratchOverlay, rewritten, 'utf8')
  } else {
    originalBaseRef = baseLeafPath
    fs.writeFileSync(scratchOverlay, [
      '- id: base',
      "  name: '@cordisjs/plugin-include'",
      '  config:',
      `    path: ${JSON.stringify(baseLeafPath)}`,
      '',
    ].join('\n'), 'utf8')
  }

  const isolated = await spawnIsolatedDaemon({
    overlayOrLeafPath: scratchOverlay,
    daemonBin,
    tsxSpecifier,
    tsxTsconfigPath,
    cwd: scratchDir,
    purpose: 'playground',
  })

  const playgroundProfile = {
    mode: 'daemon',
    daemon: {
      cmd: process.execPath,
      // The daemon is already running (isolated-daemon spawned it); we hand
      // RuntimeSupervisor a daemon spec that points at the existing socket
      // and skip its re-spawn path. The DaemonSupervisor.ensureUp() will see
      // an already-up ping and just return.
      args: ['--import', tsxSpecifier, daemonBin, scratchOverlay],
      cwd: scratchDir,
      env: {
        TSX_TSCONFIG_PATH: tsxTsconfigPath,
        DSH_DAEMON_SOCKET_PATH: isolated.socketPath,
        DSH_DAEMON_LOCKFILE_PATH: isolated.lockfilePath,
        DSH_DAEMON_SESSIONS_ROOT: isolated.sessionsRoot,
      },
      socketPath: isolated.socketPath,
    },
    model: 'mock-echo',
    label: 'playground · isolated daemon',
    protocolVersion: 2,
    capabilities: { interruptions: true },
    onInterrupt,
  }
  const supervisor = new RuntimeSupervisor({ profile: playgroundProfile })
  supervisor.on('notify', (method, params) => onNotify(method, params))
  supervisor.on('status', (s) => onStatus(s))
  supervisor.on('crash', (info) => onCrash(info))
  if (onStderr) supervisor.on('stderr', (chunk) => onStderr(chunk))
  await supervisor.start()

  return new PlaygroundSession({
    scratchOverlayPath: scratchOverlay,
    scratchDir,
    isolated,
    supervisor,
    profile: playgroundProfile,
    originalBaseRef,
  })
}

/**
 * Apply the scratch overlay to the live overlay path. Rewrites the scratch
 * overlay's `path:` (currently the absolute base leaf) back to the original
 * value (the relative-to-overlay-dir path the tab wrote), then writes the
 * bytes into `liveOverlayPath`. Restarting the main runtime is the caller's
 * job — this is only the file-plane commit.
 */
function applyScratchOverlay(playground, liveOverlayPath) {
  if (!playground || !playground.scratchOverlayPath) {
    throw new Error('applyScratchOverlay: no active playground')
  }
  fs.mkdirSync(path.dirname(liveOverlayPath), { recursive: true })
  const scratchText = fs.readFileSync(playground.scratchOverlayPath, 'utf8')
  const restored = scratchText.replace(
    /^(\s+path:\s*).+$/m,
    (_match, prefix) => `${prefix}${JSON.stringify(playground.originalBaseRef)}`,
  )
  // Atomic + undoable commit (drift D12): a mid-write crash must never
  // truncate the user's live overlay, and "Apply playground" must be
  // reversible — the overlay is project state the user may not have
  // backed up. Snapshot first, then write-to-temp + rename (atomic on
  // POSIX; same-dir so the rename never crosses filesystems).
  let backupPath = null
  if (fs.existsSync(liveOverlayPath)) {
    backupPath = `${liveOverlayPath}.bak`
    fs.copyFileSync(liveOverlayPath, backupPath)
  }
  const tmpPath = `${liveOverlayPath}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, restored, 'utf8')
  fs.renameSync(tmpPath, liveOverlayPath)
  return { ok: true, liveOverlayPath, backupPath }
}

async function stopPlayground(playground) {
  if (!playground) return
  try { await playground.supervisor.stop() } catch (_) { /* best-effort */ }
  try { await playground.isolated.dispose() } catch (_) { /* best-effort */ }
  try { fs.rmSync(playground.scratchDir, { recursive: true, force: true }) } catch (_) {}
}

module.exports = { startPlayground, applyScratchOverlay, stopPlayground, PlaygroundSession }
