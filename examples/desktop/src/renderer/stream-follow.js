// stream-follow.js — pure "auto-follow the streaming tail" controller.
//
// The chat stream auto-scrolls to the bottom as reasoning / assistant-text /
// tool-call deltas arrive (renderer.js scrollToBottom(), historically called
// unconditionally per chunk at the assistant/chunk site). That unconditional
// scroll had a bug: a reader who scrolled UP to re-read an earlier step got
// yanked back to the bottom on the very next delta, making it impossible to
// read while the model streams.
//
// This module isolates the "should we follow?" decision as pure logic so it
// is unit-testable without a DOM. renderer.js owns the wiring: it feeds the
// scroll region's metrics in on every scroll event (onScroll) and asks
// onContent() whether to hard-scroll when new streamed content lands. When
// the reader has detached, onContent stops following and signals that the
// "↓ 回到底部" chip should appear.
//
// Dual export: CommonJS for node:test, window.__dshStreamFollow for the
// renderer (same shape as the other small pure renderer modules —
// chat-refresh-throttle.js, html-escape.js).

'use strict'

;(function () {
  const DEFAULT_THRESHOLD_PX = 40

  // Distance in px from the bottom of the scroll region. 0 = pinned to the
  // very bottom; grows as the reader scrolls up. Clamped at 0 so sub-pixel
  // rounding (fractional scrollHeight/clientHeight under zoom) can't report a
  // tiny negative and read as "not at bottom".
  function distanceFromBottom (metrics) {
    if (!metrics) return 0
    const st = Number(metrics.scrollTop) || 0
    const sh = Number(metrics.scrollHeight) || 0
    const ch = Number(metrics.clientHeight) || 0
    return Math.max(0, sh - st - ch)
  }

  function isNearBottom (metrics, threshold) {
    const t = Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD_PX
    return distanceFromBottom(metrics) <= t
  }

  // Stateful controller, but pure w.r.t. the DOM: callers pass metrics in and
  // act on the returned intent. Two bits of state:
  //   pinned          — is the view following the bottom right now?
  //   detachedWithNew — has new streamed content landed since the reader
  //                     scrolled away? (drives the "back to bottom" chip)
  function createFollowController (opts) {
    const options = opts || {}
    const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD_PX
    let pinned = options.startPinned === false ? false : true
    let detachedWithNew = false

    // Call on every scroll event. Recomputes `pinned` from the metrics and
    // clears the "new while detached" flag once the reader is back at bottom.
    function onScroll (metrics) {
      const near = isNearBottom(metrics, threshold)
      pinned = near
      if (near) detachedWithNew = false
      return { pinned, showChip: detachedWithNew && !near }
    }

    // Call when new streamed content is appended. Returns whether the caller
    // should hard-scroll to the bottom (only when pinned) and whether the
    // "back to bottom" chip should be visible.
    function onContent () {
      if (pinned) return { follow: true, showChip: false }
      detachedWithNew = true
      return { follow: false, showChip: true }
    }

    // Force re-pin: chip click, or a deliberate jump (the reader sent a
    // message). Caller hard-scrolls after calling this.
    function repin () {
      pinned = true
      detachedWithNew = false
      return { pinned, showChip: false }
    }

    return {
      onScroll,
      onContent,
      repin,
      isPinned: () => pinned,
      hasDetachedContent: () => detachedWithNew,
      threshold,
    }
  }

  const api = { distanceFromBottom, isNearBottom, createFollowController, DEFAULT_THRESHOLD_PX }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.__dshStreamFollow = api
})()
