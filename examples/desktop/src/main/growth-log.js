// Growth log: append-only jsonl at ~/.dsh-desktop/growth-log.jsonl. Each
// line = one runtime-shaping event ("plugin.add", "onboarding.complete",
// "overlay.apply", …). The Growth page reads it via IPC (growth-v2.js
// consumes it alongside the compact-window history).
//
// Design:
//   - jsonl (one JSON object per line) so we can append without parsing,
//     and reads are streamable if the file grows big. The file stays small
//     in practice — one event per plugin toggle / restart / vibe, not per
//     session turn.
//   - `appendEvent` is fire-and-forget: any I/O failure is logged and
//     swallowed. The growth log is a nice-to-have, not a correctness
//     surface — if the disk is full or the dir is bad, the runtime must
//     still work.
//   - `readAll` returns the parsed array (best-effort: it skips malformed
//     lines rather than throwing, since a truncated last write from an
//     earlier crash shouldn't wipe history).
//   - The path lives under ~/.dsh-desktop/ next to user-overlay.cordis.yml
//     and config.json so backing it up is one directory copy.

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

function shellHome() {
  return process.env.DSH_DESKTOP_HOME || path.join(os.homedir(), '.dsh-desktop')
}

function growthLogPath() {
  return path.join(shellHome(), 'growth-log.jsonl')
}

// Append a single event. `kind` is a stable short label used by the model
// (`plugin.add`, `plugin.toggle`, `plugin.vibe-authored`, `overlay.apply`,
// `onboarding.complete`, …). `detail` is a plain object merged into the
// entry — no schema enforcement here so callers can attach whatever
// evidence they have (session id, plugin id, profile name, …).
function appendEvent(kind, detail) {
  if (typeof kind !== 'string' || !kind) return
  const entry = { ts: Date.now(), kind, ...(detail && typeof detail === 'object' ? detail : {}) }
  const line = JSON.stringify(entry) + '\n'
  try {
    fs.mkdirSync(shellHome(), { recursive: true })
    fs.appendFileSync(growthLogPath(), line, 'utf8')
  } catch (err) {
    // Nice-to-have surface — never throw into the caller. Debug-level so we
    // don't spam the console during normal operation on a locked-down disk.
    console.debug(`growth-log append failed (${kind}): ${err.message}`)
  }
}

// Best-effort read. Returns [] if the file doesn't exist yet.
function readAll() {
  try {
    const text = fs.readFileSync(growthLogPath(), 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch (_) {
        // Skip malformed line — likely a truncated last write.
      }
    }
    return out
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    console.debug(`growth-log read failed: ${err.message}`)
    return []
  }
}

module.exports = {
  appendEvent,
  readAll,
  growthLogPath,
  shellHome,
}
