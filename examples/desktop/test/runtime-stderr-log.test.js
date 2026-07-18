// Full-stderr log writer (2026-07-18, fix/harness-dev-guard).
//
// The main-process crash handler used to keep an 8KB stderr tail in memory
// and scan it for the api-key signature. That's fine for the classifier's
// hot path but useless for diagnosing silent-exit failures whose stack
// trace runs longer than 8KB, or where the classifier didn't match at all.
//
// runtime-stderr-log.js writes the FULL accumulated stderr to
// <userData>/logs/runtime-stderr.log so QA and users can attach it to
// a bug report. These tests drive the writer directly against a mkdtemp
// dir + verify main.js wires it into the crash/protocolError paths.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  writeRuntimeStderrLog,
  runtimeStderrLogPath,
  LOG_DIR,
  LOG_FILE,
} = require('../src/main/runtime-stderr-log.js')

function mkTmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-stderr-log-'))
}

test('runtime-stderr-log: writes header + body to <userData>/logs/runtime-stderr.log', () => {
  const dir = mkTmpUserData()
  try {
    const written = writeRuntimeStderrLog({
      userDataDir: dir,
      stderr: 'ValidationError: $.workspaceContext missing required value\n  at Config.parse (…)\n',
      meta: { profile: 'stdio-deepseek', reason: 'runtime crash', exitCode: 1, signal: null },
    })
    assert.equal(written, path.join(dir, LOG_DIR, LOG_FILE), 'return value must be the absolute log path')
    assert.equal(runtimeStderrLogPath(dir), written, 'runtimeStderrLogPath must match the writer output')
    const content = fs.readFileSync(written, 'utf8')
    assert.match(content, /# profile:\s+stdio-deepseek/, 'header names the profile')
    assert.match(content, /# reason:\s+runtime crash/, 'header names the reason')
    assert.match(content, /# exit code:\s+1/, 'header names the exit code')
    assert.match(content, /ValidationError.*workspaceContext/, 'body carries the full stderr')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime-stderr-log: overwrites on each write (last-failure record, not ring buffer)', () => {
  // We deliberately truncate on each write — the file's job is to
  // preserve the most recent failure for user support. If QA needs
  // history across runs they copy the file. Lock the shape so a future
  // "append" refactor doesn't silently grow the file forever.
  const dir = mkTmpUserData()
  try {
    writeRuntimeStderrLog({ userDataDir: dir, stderr: 'first', meta: { profile: 'a', reason: 'x' } })
    writeRuntimeStderrLog({ userDataDir: dir, stderr: 'second', meta: { profile: 'b', reason: 'y' } })
    const content = fs.readFileSync(runtimeStderrLogPath(dir), 'utf8')
    assert.doesNotMatch(content, /first/, 'previous write must be overwritten')
    assert.match(content, /second/, 'latest write must be present')
    assert.match(content, /# profile:\s+b/, 'header must reflect the latest crash context')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime-stderr-log: best-effort — returns null instead of throwing when userDataDir is missing/unwritable', () => {
  // The caller is already on an error path (supervisor crash). A write
  // failure here must never amplify the original problem, so the writer
  // swallows fs errors and returns null. main.js's `logPath` check gates
  // the "see <path>" runtime:error message on this return value.
  assert.equal(writeRuntimeStderrLog({ userDataDir: null, stderr: 'x', meta: {} }), null, 'null userDataDir → null')
  assert.equal(writeRuntimeStderrLog({ userDataDir: '', stderr: 'x', meta: {} }), null, 'empty userDataDir → null')
  // Unwritable path — pass a file where a directory is expected.
  const unwritable = path.join(os.tmpdir(), `dsh-runtime-stderr-unwritable-${process.pid}`)
  fs.writeFileSync(unwritable, 'not a directory')
  try {
    const r = writeRuntimeStderrLog({ userDataDir: unwritable, stderr: 'x', meta: {} })
    assert.equal(r, null, 'unwritable userDataDir → null (best-effort)')
  } finally {
    fs.rmSync(unwritable, { force: true })
  }
})

test('runtime-stderr-log: main.js wires the writer into crash + protocolError paths', () => {
  // Static wiring lock: the writer must be called from both the crash
  // handler (where it captures a full stderr transcript) and the
  // protocolError handler (spawn-ENOENT surfaces here without a crash
  // event because the child never spawned). If a future refactor drops
  // either wire the silent-exit case regresses.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  assert.match(src, /require\('\.\/runtime-stderr-log\.js'\)/, 'main.js must require the writer module')
  // Both paths call the flushStderrLogFile helper — anchor both call sites.
  const crashHandlerIdx = src.indexOf("supervisor.on('crash'")
  const protocolHandlerIdx = src.indexOf("supervisor.on('protocolError'")
  assert.notEqual(crashHandlerIdx, -1, 'crash handler must exist in main.js')
  assert.notEqual(protocolHandlerIdx, -1, 'protocolError handler must exist in main.js')
  const crashWindow = src.slice(crashHandlerIdx, crashHandlerIdx + 2000)
  const protocolWindow = src.slice(protocolHandlerIdx, protocolHandlerIdx + 1000)
  assert.match(crashWindow, /flushStderrLogFile\(/, 'crash handler must flush the log')
  assert.match(protocolWindow, /flushStderrLogFile\(/, 'protocolError handler must flush the log')
})

test('runtime-stderr-log: main.js keeps a full-stderr accumulator alongside the 8KB tail', () => {
  // The 8KB STDERR_ACCUM_CAP is deliberate for the signature-scan path.
  // The full accumulator must be a separate variable so trimming the
  // signature tail doesn't also lose the log-file body. Anchor both.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')
  assert.match(src, /let\s+stderrAccum\s*=\s*''/, 'main.js still declares the small signature-scan tail')
  assert.match(src, /let\s+stderrFull\s*=\s*''/, 'main.js must declare a separate full-stderr accumulator')
  assert.match(src, /STDERR_FULL_CAP\s*=\s*\d/, 'full-stderr accumulator must be bounded (avoid OOM on runaway logger)')
})
