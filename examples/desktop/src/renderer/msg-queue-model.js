// Pure model for the composer message queue (lane-msg-queue).
//
// The DSH wire accepts exactly ONE in-flight prompt per session — a second
// session/prompt while a turn is running fails on the wire. So when the user
// hits Enter mid-turn we don't drop the text and we don't error: we park it
// in a per-session FIFO and auto-send the head when the turn completes.
//
// This module is the data structure only — no DOM, no wire. The renderer
// owns the "when to enqueue vs send" decision and the "drain on turn end"
// timing; this file just holds the queues and enforces their invariants so
// the ordering/isolation semantics can be locked in `node --test` without an
// Electron harness.
//
// Shape:
//   queues: Map<sessionId, Array<{ id, text }>>
// Item ids are monotonic across the whole module (not per-session) so a
// chip's id is globally unique — the UI keys DOM nodes on it and never has
// to disambiguate by session.
//
// Invariants the renderer relies on:
//   - FIFO: enqueue appends to the tail; drain pops the head.
//   - promote(id) moves that item to the head (the "send next" affordance),
//     so the very next drain sends it regardless of arrival order.
//   - Per-session isolation: no operation on session A can read, mutate, or
//     drain session B. A drain of an empty/unknown session returns null.
//   - Empty / whitespace-only text never enqueues (returns null) — a blank
//     chip is a trap the user can't tell apart from a real queued message.

'use strict'

function createMsgQueue() {
  /** @type {Map<string, Array<{id:number,text:string}>>} */
  const queues = new Map()
  let _seq = 0

  function nextId() { _seq += 1; return _seq }

  function ensure(sessionId) {
    let q = queues.get(sessionId)
    if (!q) { q = []; queues.set(sessionId, q) }
    return q
  }

  // Append `text` to sessionId's queue. Returns the new item id, or null if
  // the text is empty/whitespace-only (never enqueue a blank).
  function enqueue(sessionId, text) {
    if (sessionId == null) return null
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) return null
    const id = nextId()
    ensure(sessionId).push({ id, text: trimmed })
    return id
  }

  // Drop the item with `id` from sessionId's queue. Returns true if removed.
  function remove(sessionId, id) {
    const q = queues.get(sessionId)
    if (!q) return false
    const i = q.findIndex((it) => it.id === id)
    if (i < 0) return false
    q.splice(i, 1)
    return true
  }

  // Rewrite the text of an existing queued item. Empty/whitespace text is
  // rejected (returns false) — the caller should treat that as "delete" if
  // it wants blank edits to remove the chip. Returns true on success.
  function update(sessionId, id, text) {
    const q = queues.get(sessionId)
    if (!q) return false
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) return false
    const it = q.find((x) => x.id === id)
    if (!it) return false
    it.text = trimmed
    return true
  }

  // Move `id` to the head of its session queue (the "send next" affordance).
  // No-op returning false if the item isn't found; a single-item or
  // already-head move succeeds (idempotent) and returns true.
  function promote(sessionId, id) {
    const q = queues.get(sessionId)
    if (!q) return false
    const i = q.findIndex((it) => it.id === id)
    if (i < 0) return false
    if (i === 0) return true
    const [it] = q.splice(i, 1)
    q.unshift(it)
    return true
  }

  // Pop and return the head item ({id,text}) of sessionId's queue, or null
  // when the queue is empty/unknown. This is the single "send one on turn
  // end" primitive — the renderer calls it exactly once per turn completion.
  function drain(sessionId) {
    const q = queues.get(sessionId)
    if (!q || q.length === 0) return null
    return q.shift()
  }

  // Return a shallow copy of sessionId's queue (safe to render from; callers
  // can't mutate the live array). Empty array for an unknown session.
  function list(sessionId) {
    const q = queues.get(sessionId)
    return q ? q.map((it) => ({ id: it.id, text: it.text })) : []
  }

  function size(sessionId) {
    const q = queues.get(sessionId)
    return q ? q.length : 0
  }

  // Empty one session's queue. Returns the number of items dropped.
  function clear(sessionId) {
    const q = queues.get(sessionId)
    if (!q) return 0
    const n = q.length
    queues.delete(sessionId)
    return n
  }

  // Empty every session's queue (runtime crash / profile switch — the old
  // session ids are a different namespace against the restarted daemon, so
  // holding their queued text would send it into the void). Returns total
  // items dropped across all sessions.
  function clearAll() {
    let n = 0
    for (const q of queues.values()) n += q.length
    queues.clear()
    return n
  }

  return { enqueue, remove, update, promote, drain, list, size, clear, clearAll }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createMsgQueue }
}
if (typeof window !== 'undefined') {
  window.__dshMsgQueueModel = { createMsgQueue }
}
