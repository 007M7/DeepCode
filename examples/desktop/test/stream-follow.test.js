// Tests for lane-p0-inspector — src/renderer/stream-follow.js.
//
// The module is a pure "should we auto-follow the streaming tail?" controller
// with no DOM. We exercise the distance math, the near-bottom threshold, and
// the stateful controller's pin/detach/repin transitions directly — these are
// the exact decisions renderer.js's followStream()/onScroll wiring consumes.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const sf = require('../src/renderer/stream-follow.js')

// --- distanceFromBottom / isNearBottom (pure math) ------------------------

test('distanceFromBottom: pinned to the very bottom reads 0', () => {
  assert.equal(sf.distanceFromBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), 0)
})

test('distanceFromBottom: scrolled up reports the gap', () => {
  assert.equal(sf.distanceFromBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 }), 400)
})

test('distanceFromBottom: clamps negative (sub-pixel rounding under zoom) to 0', () => {
  assert.equal(sf.distanceFromBottom({ scrollTop: 950, scrollHeight: 1000, clientHeight: 100 }), 0)
})

test('distanceFromBottom: missing metrics → 0 (fail safe: treat as at-bottom)', () => {
  assert.equal(sf.distanceFromBottom(null), 0)
})

test('isNearBottom: within threshold is near; beyond is not', () => {
  const m = (top) => ({ scrollTop: top, scrollHeight: 1000, clientHeight: 100 })
  assert.equal(sf.isNearBottom(m(870), 40), true, '30px from bottom ≤ 40px threshold')
  assert.equal(sf.isNearBottom(m(859), 40), false, '41px from bottom > 40px threshold')
})

test('isNearBottom: default threshold is 40px', () => {
  assert.equal(sf.DEFAULT_THRESHOLD_PX, 40)
  const m = (top) => ({ scrollTop: top, scrollHeight: 1000, clientHeight: 100 })
  assert.equal(sf.isNearBottom(m(861)), true)   // 39px
  assert.equal(sf.isNearBottom(m(855)), false)  // 45px
})

// --- createFollowController state machine ---------------------------------

test('controller: starts pinned by default', () => {
  const c = sf.createFollowController()
  assert.equal(c.isPinned(), true)
})

test('controller: startPinned:false begins detached', () => {
  const c = sf.createFollowController({ startPinned: false })
  assert.equal(c.isPinned(), false)
})

test('controller: onContent while pinned → follow, no chip', () => {
  const c = sf.createFollowController()
  const r = c.onContent()
  assert.deepEqual(r, { follow: true, showChip: false })
})

test('controller: scroll up detaches; next content does NOT follow and shows chip', () => {
  const c = sf.createFollowController({ threshold: 40 })
  // reader scrolls up 400px
  const s = c.onScroll({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 })
  assert.equal(s.pinned, false)
  assert.equal(s.showChip, false, 'no new content yet, so no chip on the scroll itself')
  // new streamed content lands while detached
  const r = c.onContent()
  assert.equal(r.follow, false, 'must NOT yank a reader who scrolled up')
  assert.equal(r.showChip, true, 'chip appears because content arrived while detached')
})

test('controller: onScroll back to bottom clears detached-content flag + chip', () => {
  const c = sf.createFollowController({ threshold: 40 })
  c.onScroll({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 }) // detach
  c.onContent() // detachedWithNew = true
  const back = c.onScroll({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }) // re-pin
  assert.equal(back.pinned, true)
  assert.equal(back.showChip, false, 'returning to bottom hides the chip')
})

test('controller: a scroll event while detached AND with pending content re-shows the chip', () => {
  const c = sf.createFollowController({ threshold: 40 })
  c.onScroll({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 }) // detach
  c.onContent() // detachedWithNew = true
  // reader nudges but stays detached (still 400px up)
  const s = c.onScroll({ scrollTop: 480, scrollHeight: 1000, clientHeight: 100 })
  assert.equal(s.pinned, false)
  assert.equal(s.showChip, true, 'still detached with pending content → chip stays')
})

test('controller: repin() forces pinned + clears chip (chip click / deliberate jump)', () => {
  const c = sf.createFollowController({ threshold: 40 })
  c.onScroll({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 })
  c.onContent()
  const r = c.repin()
  assert.deepEqual(r, { pinned: true, showChip: false })
  assert.equal(c.isPinned(), true)
  // after repin, content follows again
  assert.equal(c.onContent().follow, true)
})

test('controller: threshold is exposed for the wiring to mirror', () => {
  assert.equal(sf.createFollowController({ threshold: 25 }).threshold, 25)
  assert.equal(sf.createFollowController().threshold, 40)
})
