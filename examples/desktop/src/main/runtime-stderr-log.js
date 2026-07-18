// Runtime stderr log writer (2026-07-18, fix/harness-dev-guard).
//
// The Electron main process keeps a small in-memory tail (STDERR_ACCUM_CAP =
// 8KB) that it scans for the missing-DEEPSEEK_API_KEY signature. That cap is
// deliberate — the tail feeds a synchronous regex match on every stderr
// chunk. But when a runtime silently dies (spawn ENOENT, config schema
// error, unhandled promise rejection during plugin load), the ONLY diagnostic
// is the raw stderr — and 8KB isn't enough for a full stack trace.
//
// This module writes the FULL (uncapped) captured stderr to
// `<userData>/logs/runtime-stderr.log` on crash or protocol error, so the
// user can attach it to a bug report and QA can attach it to a probe run.
// The UI banner names the log path so users know where to find it.
//
// Kept as a standalone module so the crash path can be unit-tested without
// booting Electron (jest-style Module._load stubs of `electron` under
// StdioTransport tests already exercise that pattern).

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const LOG_FILE = 'runtime-stderr.log'
const LOG_DIR = 'logs'

/**
 * Write a stderr transcript to `<userDataDir>/logs/runtime-stderr.log`.
 * Best-effort: never throws — the caller is already on an error path and a
 * write failure here should not amplify the original failure.
 *
 * @param {object} args
 * @param {string} args.userDataDir  App user-data dir (from app.getPath('userData'))
 * @param {string} args.stderr       Full accumulated stderr (uncapped)
 * @param {object} [args.meta]       Diagnostic header — profile name, exit code, timestamp
 * @returns {string|null}            Absolute path written to, or null on failure
 */
function writeRuntimeStderrLog({ userDataDir, stderr, meta }) {
  if (!userDataDir || typeof userDataDir !== 'string') return null
  try {
    const logDir = path.join(userDataDir, LOG_DIR)
    fs.mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, LOG_FILE)
    const header = formatHeader(meta || {})
    // Truncate on each write — the file is a "last failure" record, not a
    // ring buffer. If QA needs history they can copy the file between runs.
    fs.writeFileSync(logPath, header + '\n' + (stderr || '(empty)') + '\n', 'utf8')
    return logPath
  } catch (_err) {
    return null
  }
}

function formatHeader(meta) {
  const at = meta.at || new Date().toISOString()
  const profile = meta.profile || '(unknown)'
  const exitCode = 'exitCode' in meta ? meta.exitCode : '(none)'
  const signal = 'signal' in meta ? meta.signal : '(none)'
  const reason = meta.reason || '(unspecified)'
  return [
    `# DSH runtime stderr — last failure`,
    `# at:        ${at}`,
    `# profile:   ${profile}`,
    `# reason:    ${reason}`,
    `# exit code: ${exitCode}`,
    `# signal:    ${signal}`,
    `# ------------------------------------------------------------`,
  ].join('\n')
}

/**
 * Full path this module writes to, given a userDataDir. Exposed so the
 * banner's hint text and tests can reference the same string without
 * hardcoding the layout twice.
 */
function runtimeStderrLogPath(userDataDir) {
  if (!userDataDir) return null
  return path.join(userDataDir, LOG_DIR, LOG_FILE)
}

module.exports = { writeRuntimeStderrLog, runtimeStderrLogPath, LOG_FILE, LOG_DIR }
