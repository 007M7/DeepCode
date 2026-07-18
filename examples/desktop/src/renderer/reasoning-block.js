// reasoning-block.js — first-class inline reasoning fold (#162,
// ). Pure helpers + a DOM builder that the
// TurnBuilder (assistant-turn.js, follow-up commit) invokes when a
// reasoning content block or reasoning-delta chunk arrives.
//
// Relationship to #93: removed literal `[reasoning]` /
// `[tool-call]` marker tokens from the assistant chat bubble because
// they were rendering as garbage user-visible text. This module
// KEEPS that fix (the bubble's textFromContentBlocks still ignores
// non-text content blocks) and adds reasoning back as its own DOM
// node at its position in the content array — dim, italic, collapsed
// by default, streaming into a preview. It is an upgrade of #93, not
// a rollback.
//
// Public API (all pure, safe under node --test):
//
//   previewSuffix(buffer: string, chars=40): string
//     Last N non-newline characters of the current reasoning buffer.
//     Used as the collapsed preview while streaming.
//
//   sealedPreview(buffer: string, cap=80): string
//     One-sentence extract capped at `cap` characters — the preview
//     the block keeps once reasoning_end / next non-reasoning chunk
//     fires. Falls back to the leading `cap` chars if no sentence
//     terminator is found in the first ~2*cap characters.
//
//   buildReasoningBlock(doc, { index, initialText, sealed, collapsed })
//     Returns an <div class="turn-child reasoning-block"> with a
//     compact preview row and a hidden full-text body. Streaming
//     helpers below mutate the same element in place.
//
//   appendReasoningDelta(el, text)   → mutates preview + full body
//   sealReasoningBlock(el)           → freezes preview via sealedPreview
//   setReasoningCollapsed(el, bool)  → toggles the collapse state
//
// Collapse state persistence is the caller's job: pass `collapsed`
// from the TurnBuilder's per-turn (turnId, blockIndex) map into
// buildReasoningBlock; TurnBuilder listens for the disclosure click
// and writes back to its map.

'use strict'

const DEFAULT_PREVIEW_CHARS = 40
const DEFAULT_SEALED_CAP = 80

function previewSuffix(buffer, chars = DEFAULT_PREVIEW_CHARS) {
  if (typeof buffer !== 'string' || buffer.length === 0) return ''
  const oneLine = buffer.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= chars) return oneLine
  return '…' + oneLine.slice(-chars)
}

function sealedPreview(buffer, cap = DEFAULT_SEALED_CAP) {
  if (typeof buffer !== 'string' || buffer.length === 0) return ''
  const oneLine = buffer.replace(/\s+/g, ' ').trim()
  // First sentence-ish: text up to the first .?! followed by a space or
  // end-of-string, looking within the leading 2*cap characters so a
  // pathological run-on doesn't scan the whole buffer.
  const scanTo = Math.min(oneLine.length, cap * 2)
  const head = oneLine.slice(0, scanTo)
  const m = head.match(/^[^.!?]*[.!?](?=\s|$)/)
  const candidate = m ? m[0] : head
  if (candidate.length <= cap) return candidate
  return candidate.slice(0, cap - 1) + '…'
}

// -- DOM builder + streaming helpers ------------------------------------

function buildReasoningBlock(doc, opts) {
  const options = opts || {}
  const el = doc.createElement('div')
  el.className = 'turn-child reasoning-block'
  const idx = Number(options.index)
  if (Number.isFinite(idx)) el.dataset.blockIndex = String(idx)
  const initialText = typeof options.initialText === 'string' ? options.initialText : ''
  const sealed = options.sealed === true
  el.dataset.sealed = sealed ? '1' : '0'
  // C15 (drift cycle 13/14): dataset.buffer removed — body.textContent
  // is the single source of truth for the reasoning text.

  // Row layout mirrors the L0 rules in density-layering-spec.md §2:
  // one line, glyph column, name, preview text, no chevron emoji.
  // The row is a <button> so keyboard/hover semantics come for free.
  const row = doc.createElement('button')
  row.type = 'button'
  row.className = 'reasoning-row'
  const glyph = doc.createElement('span')
  glyph.className = 'reasoning-glyph'
  // C11 (drift cycle 13/14): folded glyph is ▹ (open triangle) so it
  // doesn't collide with tool-row's ▸ in-flight marker — a folded
  // reasoning row and a running tool row would otherwise land the
  // same glyph in the same column. When expanded, CSS rotates the
  // glyph 90° (see [data-collapsed="0"] rule in style.css). Sealed +
  // unsealed both start folded; only the collapse state controls the
  // glyph choice.
  glyph.textContent = '▹'
  const label = doc.createElement('span')
  label.className = 'reasoning-label'
  label.textContent = 'thinking'
  const dot = doc.createElement('span')
  dot.className = 'reasoning-sep'
  dot.textContent = ' · '
  const preview = doc.createElement('span')
  preview.className = 'reasoning-preview'
  preview.textContent = sealed
    ? sealedPreview(initialText)
    : previewSuffix(initialText)
  row.append(glyph, label, dot, preview)

  const body = doc.createElement('div')
  body.className = 'reasoning-body'
  body.textContent = initialText
  body.hidden = !(options.collapsed === false)

  // Collapse state: `data-collapsed="1"` = folded row only, body hidden.
  const collapsed = options.collapsed !== false
  el.dataset.collapsed = collapsed ? '1' : '0'
  body.hidden = collapsed

  row.addEventListener('click', () => {
    const now = el.dataset.collapsed !== '1'
    setReasoningCollapsed(el, now)
    if (typeof options.onToggle === 'function') {
      options.onToggle({ index: idx, collapsed: now })
    }
  })

  el.append(row, body)
  return el
}

function appendReasoningDelta(el, text) {
  if (!el || typeof text !== 'string' || text.length === 0) return
  // C15 (drift cycle 13/14): O(N²) fix — the previous shape stored the
  // full buffer twice (el.dataset.buffer + body.textContent) and read
  // the whole thing back on every delta to concatenate + reassign, so
  // N deltas of length k total O(N²k). Body.textContent is now the
  // single source of truth; we append via a text node (constant-time
  // DOM append) and only re-read `body.textContent` when the preview
  // needs a fresh tail. `dataset.buffer` retired.
  const body = el.querySelector('.reasoning-body')
  if (body) {
    const doc = body.ownerDocument || (typeof document !== 'undefined' ? document : null)
    if (doc) body.appendChild(doc.createTextNode(text))
    else body.textContent = (body.textContent || '') + text
  }
  const preview = el.querySelector('.reasoning-preview')
  if (preview) preview.textContent = previewSuffix((body && body.textContent) || '')
}

function sealReasoningBlock(el) {
  if (!el) return
  el.dataset.sealed = '1'
  const preview = el.querySelector('.reasoning-preview')
  const body = el.querySelector('.reasoning-body')
  const buffer = (body && body.textContent) || ''
  if (preview) preview.textContent = sealedPreview(buffer)
}

function setReasoningCollapsed(el, collapsed) {
  if (!el) return
  el.dataset.collapsed = collapsed ? '1' : '0'
  const body = el.querySelector('.reasoning-body')
  if (body) body.hidden = !!collapsed
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    previewSuffix, sealedPreview,
    buildReasoningBlock, appendReasoningDelta, sealReasoningBlock, setReasoningCollapsed,
    DEFAULT_PREVIEW_CHARS, DEFAULT_SEALED_CAP,
  }
}
if (typeof window !== 'undefined') {
  window.__dshReasoningBlock = {
    previewSuffix, sealedPreview,
    buildReasoningBlock, appendReasoningDelta, sealReasoningBlock, setReasoningCollapsed,
  }
}
