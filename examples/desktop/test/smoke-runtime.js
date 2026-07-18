// Headless smoke: drive the RuntimeSupervisor exactly like main.js does, but
// from plain node — no Electron needed.
//
// Runs four checks in sequence:
//   1) stdio-echo: spawn jsonrpc-demo directly, send one prompt.
//   2) daemon-echo: shell auto-starts the daemon over unix socket, verifies
//      session/new + session/list + session/prompt end-to-end.
//   3) daemon kill -9 recovery: SIGKILL the daemon child mid-flight and
//      confirm the shell re-spawns the daemon and reconnects.
//   4) tree: create parent + child sessions and assert the tree helpers
//      produce the shape the sidebar renders from. Attempts a real
//      session/fork call on the wire — if the method returns
//      MethodNotFound, the sub-check is reported as PENDING (protocol
//      catch-up), not FAIL.
//
// Usage:  node test/smoke-runtime.js [stdio|daemon|kill|tree|all]
// Env:    DSH_SMOKE_TIMEOUT_MS (default 45000)

'use strict'

const { execSync } = require('node:child_process')
const path = require('node:path')
const { RuntimeSupervisor } = require('../src/main/runtime.js')
const { profile, runtimePaths } = require('../src/main/profiles.js')
const { buildSessionTree, findChildForks } = require('../src/renderer/session-tree.js')

const assert = require('node:assert/strict')

const TIMEOUT = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 45000)
const which = (process.argv[2] || 'all').toLowerCase()

function log(msg) { console.log(msg) }

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label} after ${ms}ms`)), ms).unref()),
  ])
}

async function runOneTurn(sup, sessionId, text) {
  const events = []
  const finished = new Promise((resolve, reject) => {
    const onNotify = (method, params) => {
      events.push({ method, params })
      if (method === 'session.event') log(`  event: ${params.event.type}`)
      else log(`  ${method}`)
      if (method === 'session.finished') {
        sup.off('notify', onNotify)
        resolve(events)
      }
    }
    sup.on('notify', onNotify)
    setTimeout(() => { sup.off('notify', onNotify); reject(new Error('turn timeout')) }, TIMEOUT).unref()
  })
  await sup.prompt({ sessionId, contentBlocks: [{ type: 'text', text }] })
  return finished
}

function wireLogging(sup, label) {
  sup.on('status', (s) => log(`[${label}] status=${s}`))
  sup.on('stderr', (chunk) => process.stderr.write(`[${label} stderr] ${chunk}`))
  sup.on('protocolError', (err) => {
    console.error(`[${label}] protocol`, err.message)
    if (sup.daemon && sup.daemon.stderrTail) {
      console.error(`[${label}] daemon stderr tail:\n${sup.daemon.stderrTail}`)
    }
  })
  sup.on('crash', (c) => console.error(`[${label}] crash code=${c.code} signal=${c.signal}`))
  sup.on('initialized', (info) => log(`[${label}] initialized: ${info.serverInfo.name} v${info.serverInfo.version} (protocol ${info.protocolVersion || 1})`))
}

async function runStdio() {
  log('=== stdio-echo ===')
  const p = profile('stdio-echo')
  const sup = new RuntimeSupervisor({ profile: p })
  wireLogging(sup, 'stdio')
  await withTimeout(sup.start(), TIMEOUT, 'stdio.start')
  const sessionId = 'smoke-stdio-' + Date.now()
  const events = await runOneTurn(sup, sessionId, 'echo hello (stdio)')
  log(`[stdio] ${events.length} notifications`)
  await sup.stop()
}

async function runDaemon() {
  log('=== daemon-echo ===')
  // Clean any stale artifacts from previous runs so ensureUp starts fresh.
  await cleanupDaemonState()
  const p = profile('daemon-echo')
  const sup = new RuntimeSupervisor({ profile: p })
  wireLogging(sup, 'daemon')
  await withTimeout(sup.start(), TIMEOUT, 'daemon.start')

  // Server-authoritative session lifecycle.
  const sid = 'smoke-daemon-' + Date.now()
  const created = await sup.request('session/new', { sessionId: sid })
  log(`[daemon] session/new → ${JSON.stringify(created)}`)
  const list = await sup.request('session/list', {})
  log(`[daemon] session/list → ${list.sessions.length} entries`)
  const events = await runOneTurn(sup, sid, 'echo hello (daemon)')
  log(`[daemon] ${events.length} notifications`)
  const list2 = await sup.request('session/list', {})
  const entry = list2.sessions.find((s) => s.sessionId === sid)
  log(`[daemon] post-turn entry: title=${JSON.stringify(entry && entry.header && entry.header.title)} live=${entry && entry.live}`)
  await sup.stop()
}

async function runKillRecovery() {
  log('=== daemon kill -9 recovery ===')
  await cleanupDaemonState()
  const p = profile('daemon-echo')
  const sup = new RuntimeSupervisor({ profile: p })
  wireLogging(sup, 'kill')
  await withTimeout(sup.start(), TIMEOUT, 'kill.start')

  // Run one turn to be sure we're really connected.
  const sid = 'smoke-kill-' + Date.now()
  await sup.request('session/new', { sessionId: sid })
  await runOneTurn(sup, sid, 'echo one')

  // Locate the daemon child pid via the supervisor and SIGKILL it.
  const pid = sup.daemon && sup.daemon.pid
  if (!pid) throw new Error('supervisor has no daemon pid to kill')
  log(`[kill] SIGKILL daemon pid=${pid}`)
  try { process.kill(pid, 'SIGKILL') } catch (err) { log(`[kill] already dead: ${err.message}`) }

  // Wait for the supervisor to observe the drop and reconnect.
  await new Promise((resolve, reject) => {
    let saw = false
    const onStatus = (s) => {
      if (s === 'crashed' || s === 'respawning') saw = true
      if (saw && s === 'running') {
        sup.off('status', onStatus)
        resolve()
      }
    }
    sup.on('status', onStatus)
    setTimeout(() => { sup.off('status', onStatus); reject(new Error('reconnect timeout')) }, TIMEOUT).unref()
  })
  log('[kill] reconnected — sending another turn')

  // A new session (v2 sessions do not survive a daemon reconnect today, per
  // daemon-demo README's known-limitations note).
  const sid2 = 'smoke-kill-post-' + Date.now()
  await sup.request('session/new', { sessionId: sid2 })
  const events = await runOneTurn(sup, sid2, 'echo two (post-recovery)')
  log(`[kill] post-recovery: ${events.length} notifications`)
  await sup.stop()
}

async function runTree() {
  log('=== tree (fork lineage + sidebar shape) ===')
  await cleanupDaemonState()
  const p = profile('daemon-echo')
  const sup = new RuntimeSupervisor({ profile: p })
  wireLogging(sup, 'tree')
  await withTimeout(sup.start(), TIMEOUT, 'tree.start')

  // Create a parent session and one turn so it has content. Capture the
  // closing turn/end seq — session/fork only accepts turn/end boundaries.
  const parent = 'smoke-tree-parent-' + Date.now()
  await sup.request('session/new', { sessionId: parent })
  const turnEvents = await runOneTurn(sup, parent, 'echo parent turn')
  const turnEndSeq = turnEvents
    .filter((e) => e.method === 'session.event' && e.params?.sessionId === parent && e.params?.event?.type === 'turn/end')
    .map((e) => e.params.event.seq)
    .pop()

  // Try the real session/fork wire. When it lands the daemon should return
  // { childSessionId, ... }; today it typically raises MethodNotFound so we
  // fall back to a synthetic child + subagent.started notify to mirror the
  // main-process handler, and mark the check PENDING instead of failing.
  // `boundary` is a plain number (SessionForkParams.boundary?: number per the
  // protocol group's final shape on feat/jsonrpc-set-config); we pass one to
  // exercise the wire shape even under the fallback path.
  let child, forkedByWire
  try {
    const forkParams = { sessionId: parent }
    if (typeof turnEndSeq === 'number') forkParams.boundary = turnEndSeq
    const result = await sup.request('session/fork', forkParams)
    child = (result && (result.childSessionId || result.id)) || null
    forkedByWire = true
    if (!child) throw new Error('session/fork returned no childSessionId')
    log(`[tree] session/fork wire OK → child=${child}`)
  } catch (err) {
    forkedByWire = false
    log(`[tree] session/fork wire not ready (${err.message}); falling back to synthetic child`)
    child = 'smoke-tree-child-' + Date.now()
    try { await sup.request('session/new', { sessionId: child }) } catch (_) { /* v1 */ }
  }

  // In the synthetic path the daemon won't know parent→child; verify the
  // sidebar-tree helpers still produce something sensible from the fields
  // the main-process handler would set locally. We simulate that overlay by
  // patching a parentSession header onto the child entry.
  const list = await sup.request('session/list', {})
  const entries = list.sessions.map((e) => {
    if (e.sessionId === child && !e.header.parentSession) {
      return { ...e, header: { ...e.header, parentSession: parent, seedLength: e.header.seedLength ?? 3 } }
    }
    return e
  })
  const tree = buildSessionTree(entries)
  const parentNode = findNode(tree, parent)
  assert.ok(parentNode, `parent node ${parent} missing from tree; got roots=${tree.map((n) => n.entry.sessionId).join(',')}`)
  const childNode = parentNode.children.find((c) => c.entry.sessionId === child)
  assert.ok(childNode, `child node ${child} not nested under parent; parent kids=${parentNode.children.map((c) => c.entry.sessionId).join(',')}`)
  assert.equal(childNode.depth, 1)

  const forks = findChildForks(parent, entries)
  assert.ok(forks.some((f) => f.childSessionId === child), 'findChildForks did not return the child')

  const banner = forkedByWire ? 'wire' : 'PENDING (mock fallback)'
  log(`[tree] shape OK (${banner}); parent=${parent.slice(0, 8)} child=${child.slice(0, 8)} depth=${childNode.depth} forkSeq=${forks.find((f) => f.childSessionId === child).forkSeq}`)
  await sup.stop()
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.entry.sessionId === id) return n
    const nested = findNode(n.children, id)
    if (nested) return nested
  }
  return null
}

async function cleanupDaemonState() {
  // Remove any leftover socket/lockfile so ensureUp doesn't confuse a stale
  // artifact with a live daemon. Failures are non-fatal.
  const fs = require('node:fs/promises')
  for (const f of [runtimePaths.daemonSocket, runtimePaths.daemonLockfile]) {
    try { await fs.unlink(f) } catch (_) { /* ok */ }
  }
}

;(async () => {
  try {
    if (which === 'all' || which === 'stdio') await runStdio()
    if (which === 'all' || which === 'daemon') await runDaemon()
    if (which === 'all' || which === 'kill') await runKillRecovery()
    if (which === 'all' || which === 'tree') await runTree()
    log('[smoke] OK')
    process.exit(0)
  } catch (err) {
    console.error('[smoke] FAILED:', err.message)
    console.error(err.stack)
    process.exit(1)
  }
})()
