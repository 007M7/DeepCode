// feedback-annotations.js — per-event RL-annotation store (lane-wf-feedback).
//
// The inspector's Feedback tab lets a researcher annotate any single session
// event: thumbs up/down + a free-text note + an optional rubric dimension.
// This is the RL-annotation seed — the record shape is deliberately forward-
// compatible so a later trajectory-GRM pipeline can consume it as-is:
//
//   { sessionId, seq, verdict, note, rubricDim?, at }
//
// Why a new side file rather than growth-v2? growth-v2 stores rubrics/errors
// keyed by COMPACT WINDOW (one file per window). Event-level annotations are
// keyed by (sessionId, seq) — a different grain that doesn't fit that shape.
// So this mirrors the growth-v2 IPC style (main-process module + preload
// namespace) but lands in its own append-safe JSON file under ~/.dsh-desktop,
// next to growth-log.jsonl / user-overlay.cordis.yml.
//
// Layout: `~/.dsh-desktop/feedback-annotations.json` — a single flat array of
// records. One file (not per-session) because the demo scale is small and a
// single file keeps the "export the whole RL seed" story a one-liner. Writes
// rewrite the whole file (no partial-write tearing).
//
// Upsert semantics: (sessionId, seq) is the identity. Re-annotating the same
// event overwrites its record (verdict/note/rubricDim), refreshing `at`. A
// verdict of null with an empty note clears the annotation (delete).

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

function shellHome() {
  return process.env.DSH_DESKTOP_HOME || path.join(os.homedir(), '.dsh-desktop')
}

function annotationsPath() {
  return path.join(shellHome(), 'feedback-annotations.json')
}

const VALID_VERDICTS = new Set(['up', 'down'])

function readAllRaw() {
  try {
    const text = fs.readFileSync(annotationsPath(), 'utf8')
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    console.debug(`feedback-annotations read failed: ${err.message}`)
    return []
  }
}

function writeAll(arr) {
  const p = annotationsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8')
}

// Return every annotation. The renderer indexes them by (sessionId, seq) to
// paint the ✓ marker + prefill the Feedback tab, so the wire is a flat list.
function list() {
  return { ok: true, entries: readAllRaw() }
}

// Normalize + validate one incoming annotation form. Returns a clean record
// or null when it isn't a usable annotation (no verdict AND no note → clear).
function normalize(form) {
  if (!form || typeof form !== 'object') return null
  const sessionId = String(form.sessionId || '').trim()
  const seq = Number(form.seq)
  if (!sessionId || !Number.isFinite(seq)) return null
  const verdict = VALID_VERDICTS.has(form.verdict) ? form.verdict : null
  const note = typeof form.note === 'string' ? form.note.trim() : ''
  const rubricDim = (typeof form.rubricDim === 'string' && form.rubricDim.trim())
    ? form.rubricDim.trim()
    : undefined
  // No verdict and no note → nothing to store (treated as a clear upstream).
  if (verdict === null && !note) return null
  const rec = { sessionId, seq, verdict, note, at: Date.now() }
  if (rubricDim) rec.rubricDim = rubricDim
  return rec
}

// Upsert one annotation keyed by (sessionId, seq). Returns { ok, entry } on a
// write, { ok:true, cleared:true } when the form clears an existing record,
// or { ok:false, reason } on a malformed form.
function upsert(form) {
  const sessionId = form && String(form.sessionId || '').trim()
  const seq = form && Number(form.seq)
  if (!sessionId || !Number.isFinite(seq)) return { ok: false, reason: 'sessionId-and-seq-required' }
  const arr = readAllRaw()
  const idx = arr.findIndex((r) => r && r.sessionId === sessionId && Number(r.seq) === seq)
  const rec = normalize(form)
  if (rec === null) {
    // Clear: drop any existing record for this (sessionId, seq).
    if (idx >= 0) {
      arr.splice(idx, 1)
      writeAll(arr)
      return { ok: true, cleared: true }
    }
    return { ok: false, reason: 'empty-annotation' }
  }
  if (idx >= 0) arr[idx] = rec
  else arr.push(rec)
  writeAll(arr)
  return { ok: true, entry: rec }
}

// Remove one annotation. Returns { ok, removed:boolean }.
function remove(form) {
  const sessionId = form && String(form.sessionId || '').trim()
  const seq = form && Number(form.seq)
  if (!sessionId || !Number.isFinite(seq)) return { ok: false, reason: 'sessionId-and-seq-required' }
  const arr = readAllRaw()
  const idx = arr.findIndex((r) => r && r.sessionId === sessionId && Number(r.seq) === seq)
  if (idx < 0) return { ok: true, removed: false }
  arr.splice(idx, 1)
  writeAll(arr)
  return { ok: true, removed: true }
}

module.exports = {
  shellHome,
  annotationsPath,
  list,
  upsert,
  remove,
  normalize,
  VALID_VERDICTS,
}
