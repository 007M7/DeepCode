// feedback-annotation-model.js — pure model for the inspector Feedback tab
// (lane-wf-feedback). The RL-annotation seed.
//
// The Feedback tab annotates a single session event: thumbs up/down + a free-
// text note + an optional rubric dimension. The persisted record is keyed by
// (sessionId, seq) and shaped for a downstream trajectory-GRM pipeline:
//
//   { sessionId, seq, verdict: 'up'|'down'|null, note: string,
//     rubricDim?: string, at: number }
//
// This module is the DATA + PURE HELPERS only — no DOM, no IPC. The renderer
// owns "read via window.dsh.feedback on open, write on submit"; this file:
//   - derives the identity key from an inspector event,
//   - normalizes a form into the forward-compatible record shape,
//   - maintains an in-memory index (sessionId,seq → record) so the ✓ marker
//     and prefill are synchronous (no round-trip on every badge render).
//
// The main-process feedback-annotations.js is the source of truth on disk;
// this index is a renderer-side cache hydrated from feedback.list() at boot
// and kept in step on each upsert/clear.

'use strict'

const VALID_VERDICTS = ['up', 'down']

// Stable string key for the (sessionId, seq) identity. Kept as one function so
// the index writer and the marker reader can never drift.
function keyFor(sessionId, seq) {
  const sid = String(sessionId == null ? '' : sessionId)
  const s = Number(seq)
  if (!sid || !Number.isFinite(s)) return null
  return `${sid}::${s}`
}

// Pull (sessionId, seq) out of an inspector event + its owning session. The
// inspector opens on a session.event that carries `seq`; the sessionId comes
// from the caller (the active/owning session), since a reconstructed event may
// not carry it. Returns { sessionId, seq } | null.
function identityFor(event, sessionId) {
  if (!event || typeof event !== 'object') return null
  const seq = Number(event.seq)
  if (!Number.isFinite(seq)) return null
  const sid = String(sessionId == null ? '' : sessionId)
  if (!sid) return null
  return { sessionId: sid, seq }
}

// Normalize a raw form ({ sessionId, seq, verdict, note, rubricDim }) into the
// persisted record shape, or null when there's nothing worth storing (no
// verdict AND no note → a clear). Mirrors the main-process normalize() so the
// renderer's optimistic cache matches what lands on disk.
function normalize(form) {
  if (!form || typeof form !== 'object') return null
  const id = identityFor({ seq: form.seq }, form.sessionId)
  if (!id) return null
  const verdict = VALID_VERDICTS.indexOf(form.verdict) >= 0 ? form.verdict : null
  const note = typeof form.note === 'string' ? form.note.trim() : ''
  const rubricDim = (typeof form.rubricDim === 'string' && form.rubricDim.trim())
    ? form.rubricDim.trim()
    : undefined
  if (verdict === null && !note) return null
  const rec = { sessionId: id.sessionId, seq: id.seq, verdict, note }
  if (rubricDim) rec.rubricDim = rubricDim
  rec.at = Number.isFinite(form.at) ? form.at : Date.now()
  return rec
}

function createAnnotationIndex() {
  /** @type {Map<string, object>} */
  const byKey = new Map()

  // Hydrate from a flat list (feedback.list().entries). Ignores malformed
  // records so a hand-edited file can't crash the marker pass.
  function hydrate(entries) {
    byKey.clear()
    if (!Array.isArray(entries)) return
    for (const e of entries) {
      const k = keyFor(e && e.sessionId, e && e.seq)
      if (k) byKey.set(k, e)
    }
  }

  // Look up the record for (sessionId, seq), or null. Drives the ✓ marker +
  // Feedback-tab prefill.
  function get(sessionId, seq) {
    const k = keyFor(sessionId, seq)
    return k ? (byKey.get(k) || null) : null
  }

  function has(sessionId, seq) {
    const k = keyFor(sessionId, seq)
    return k ? byKey.has(k) : false
  }

  // Apply a normalized record (or a clear) to the cache. Pass the FORM; a form
  // that normalizes to null clears the (sessionId, seq) entry. Returns the
  // stored record, or null on a clear/invalid.
  function put(form) {
    const id = identityFor({ seq: form && form.seq }, form && form.sessionId)
    if (!id) return null
    const k = keyFor(id.sessionId, id.seq)
    const rec = normalize(form)
    if (rec === null) {
      byKey.delete(k)
      return null
    }
    byKey.set(k, rec)
    return rec
  }

  function remove(sessionId, seq) {
    const k = keyFor(sessionId, seq)
    if (!k) return false
    return byKey.delete(k)
  }

  function size() { return byKey.size }

  function all() { return Array.from(byKey.values()) }

  return { hydrate, get, has, put, remove, size, all }
}

const feedbackModelApi = {
  VALID_VERDICTS,
  keyFor,
  identityFor,
  normalize,
  createAnnotationIndex,
}
if (typeof module !== 'undefined' && module.exports) module.exports = feedbackModelApi
if (typeof window !== 'undefined') window.__dshFeedbackModel = feedbackModelApi
