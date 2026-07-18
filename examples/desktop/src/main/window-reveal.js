// QA-only window reveal seam. Extracted from main.js so we can unit-test the
// reveal handshake (showInactive + darwin workspace flag restore) without
// booting the full Electron shell.
//
// Background: CDP Page.captureScreenshot hangs on a hidden Electron window
// because Chromium has no compositor surface to grab a frame from. To unblock
// the QA walkthrough without stealing focus from whatever the user is doing,
// we make the window visible with showInactive() (no focus steal), and — on
// macOS — temporarily set visibleOnAllWorkspaces so the window renders on the
// user's current Space rather than the one it was created on. We restore the
// flag before returning so the window doesn't stalk the user across Spaces.
//
// This is a QA-only seam; main.js should register it only when
// process.env.DSH_QA === '1'. Production preload never sees the channel.

'use strict'

async function revealWindow(win, { platform = process.platform, sleep } = {}) {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' }
  const canFlip = platform === 'darwin' && typeof win.setVisibleOnAllWorkspaces === 'function'
  const wasVisibleOnAllWorkspaces = canFlip && typeof win.isVisibleOnAllWorkspaces === 'function'
    ? win.isVisibleOnAllWorkspaces() : false
  try {
    if (canFlip) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    // showInactive gives the window a compositor surface without stealing
    // focus. This is the whole point of the seam.
    win.showInactive()
    // Yield ~one frame so WindowServer can allocate the surface before the
    // caller asks for a screenshot. Empirically 50-60ms is enough on M-series.
    const nap = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms))
    await nap(60)
    return { ok: true }
  } finally {
    if (canFlip && !wasVisibleOnAllWorkspaces) {
      win.setVisibleOnAllWorkspaces(false)
    }
  }
}

module.exports = { revealWindow }
