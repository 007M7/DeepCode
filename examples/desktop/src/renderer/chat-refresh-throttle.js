// chat-refresh-throttle.js — rAF-coalesced throttle for the drawer + Session
// Graph refresh path.
//
// Long sessions (500+ events on replay/backfill) fire onSessionEvent
// hundreds of times per tick. The drawer and Session Graph each re-derive
// their full row/node list from cachedEvents (O(N)) on every refresh, so
// an unthrottled call site turns into O(N²) work on the main thread —
// typing visibly lags once the drawer is open. Coalescing multiple
// schedule() calls within a single rAF frame is sound: the derive is a
// pure function of cachedEvents, so intermediate ticks are always
// superseded by the final one.
//
// Kept tiny and dependency-free so tests can drive it with a fake `raf`
// hook without booting the renderer.

'use strict'

;(function () {

function create(callback, opts) {
  opts = opts || {}
  const raf = typeof opts.raf === 'function'
    ? opts.raf
    : ((typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (cb) => setTimeout(cb, 16))
  let pending = false
  function schedule() {
    if (pending) return
    pending = true
    raf(() => {
      pending = false
      try { callback() } catch (_) { /* callbacks own their errors */ }
    })
  }
  return {
    schedule,
    // Test hook — lets a caller assert whether a schedule collapsed into
    // an existing pending frame.
    isPending() { return pending },
  }
}

const api = { create }

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshChatRefreshThrottle = api

})()
