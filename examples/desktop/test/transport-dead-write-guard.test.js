// StdioTransport.write must not throw after the child has exited
//
// The default-profile-real probe surfaced a race: when the deepseek runtime
// dies during plugin load (config drift, missing api key, spawn ENOENT),
// the supervisor still has a queued initialize frame in flight. transport.js
// used to `throw new Error('runtime not writable')` synchronously if
// child.stdin.writable was false, and the caller (runtime.js _spawnOnce)
// wraps that in try/catch → emits `protocolError` → the renderer shows a
// generic "Runtime warning" banner with the bland message. Meanwhile the
// child's real stderr (e.g. `llm-deepseek: an API key is required`) is
// still being drained into stderrAccum; the exit → crash handler would
// scan and classify it correctly — but only if `protocolError` didn't
// beat it to the banner.
//
// Fix: drop the frame silently (emit `dropped` so tests + verbose logs can
// observe it), let the exit path fire, let the crash handler read the
// stderr tail, and let the classifier surface the real cause.
//
// This test drives the guard directly using a mock child (spawn is stubbed
// via a custom module hook). We construct a StdioTransport, call `start()`,
// simulate the child exiting, then call `write()`. The call must return
// without throwing and must emit `dropped` with the frame.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')

// Load StdioTransport with an intercepted `node:child_process` so `spawn`
// returns a controllable fake child. Same pattern as the daemon supervisor
// tests — Module._load override keyed on the exact module id.
const Module = require('node:module')
const origLoad = Module._load
const spawnCalls = []
let fakeChild = null
function makeFakeChild() {
  const ee = new EventEmitter()
  ee.stdin = new EventEmitter()
  ee.stdin.writable = true
  ee.stdin.write = (frame) => { ee.stdin._lastFrame = frame; return true }
  ee.stdin.end = () => { ee.stdin.writable = false }
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.killed = false
  ee.kill = () => { ee.killed = true }
  return ee
}
Module._load = function patched(request, parent, ...rest) {
  if (request === 'node:child_process') {
    return {
      spawn(cmd, args, opts) {
        spawnCalls.push({ cmd, args, opts })
        fakeChild = makeFakeChild()
        return fakeChild
      },
    }
  }
  return origLoad.call(this, request, parent, ...rest)
}

const { StdioTransport } = require(path.join(__dirname, '..', 'src', 'main', 'transport.js'))

test.after(() => { Module._load = origLoad })

test('write() drops silently and emits `dropped` when child has exited', () => {
  const t = new StdioTransport({ cmd: 'node', args: ['-e', ';'], cwd: '/tmp', env: {} })
  t.start()
  assert.ok(fakeChild, 'spawn stub must have fired')

  // Simulate the child exiting mid-init (schema drift, missing key).
  fakeChild.stdin.writable = false
  const exits = []
  t.on('exit', (info) => exits.push(info))
  fakeChild.emit('exit', 0, null)

  // A queued frame arrives after the exit. Must not throw.
  const dropped = []
  t.on('dropped', (frame) => dropped.push(frame))
  assert.doesNotThrow(() => t.write('{"jsonrpc":"2.0","method":"initialize","id":1}\n'))
  assert.equal(dropped.length, 1, 'dropped frame must fire an event so verbose logs can see it')
  assert.match(dropped[0], /initialize/, 'the actual frame must be forwarded to the dropped event')

  // The exit handler must have fired so the crash → classify path can run.
  assert.equal(exits.length, 1, 'exit must have propagated with the stderr tail')
})

test('write() drops silently before start() has spawned a child', () => {
  const t = new StdioTransport({ cmd: 'node', args: [], cwd: '/tmp', env: {} })
  // No .start() call — child is still null. A stray write must not crash the
  // supervisor; a caller that races start would otherwise land in the
  // generic protocolError banner path.
  const dropped = []
  t.on('dropped', (frame) => dropped.push(frame))
  assert.doesNotThrow(() => t.write('early-frame'))
  assert.equal(dropped.length, 1, 'pre-start write must emit dropped')
})

test('write() forwards to child.stdin when the child is alive', () => {
  const t = new StdioTransport({ cmd: 'node', args: [], cwd: '/tmp', env: {} })
  t.start()
  const dropped = []
  t.on('dropped', (frame) => dropped.push(frame))
  t.write('live-frame')
  assert.equal(dropped.length, 0, 'live writes must not fall into the dropped path')
  assert.equal(fakeChild.stdin._lastFrame, 'live-frame', 'the frame must reach child.stdin.write')
})
