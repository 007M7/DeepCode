(function () {
// Pure layout-hint engine for the DSH desktop shell. No DOM, no timers, no
// protocol — takes session events + meta in, emits one of four layout
// buckets out. Both the renderer (via <script>) and node --test (via
// require) consume the same module, mirroring session-tree.js.
//
// Buckets and the intent behind them:
//
//   'chat'         Default. Message-thread reading experience.
//   'code-review'  Diff/file-editing traffic dominates. Widen the main
//                  column, force tool blocks visually open so you see diffs
//                  without clicking every one.
//   'artifact'     An artifact preview is (or was recently) in play.
//                  Reserve a right-hand rail; the artifact card itself
//                  ships on another branch — this module only decides
//                  when to make room.
//   'monitor'      Long-running turn with bash-dense output. Tighten
//                  padding, drop font-size a hair, keep the reader
//                  glued to the tail.
//
// The tracker is deliberately conservative:
//   - N consecutive stable proposals required before switching layout
//     (default 3), so a lone diff edit doesn't flip you into code-review.
//   - Artifact is priced against the recent slice only (last ~10 signals),
//     so a stale artifact from many turns ago drops out on its own.
//   - Manual lock wins: once the user picks a layout from the indicator
//     dropdown, the tracker stops proposing until unlock().
//
// Nothing about the wire has changed. We're reading `session.event`
// notifications that renderer.js already receives and inferring intent
// from their shape.

'use strict'

// -- tool-name classifiers ----------------------------------------------------
//
// Heuristic pattern lists, not exhaustive. Matches common naming
// conventions from Claude / Cursor / DSH built-ins. When in doubt, a
// tool falls through to 'other' and doesn't contribute to any bucket.

const DIFF_TOOL_PATTERNS = [
  /^edit(_file)?$/i,
  /^write(_file)?$/i,
  /^create_file$/i,
  /^apply_patch$/i,
  /^str_replace(_editor)?$/i,
  /^patch$/i,
  /^multi_?edit$/i,
  /^notebook_?edit$/i,
  /^update_file$/i,
]

const BASH_TOOL_PATTERNS = [
  /^bash$/i,
  /^shell$/i,
  /^run(_command|_shell|_script)?$/i,
  /^execute(_command)?$/i,
  /^terminal$/i,
]

const ARTIFACT_TOOL_PATTERNS = [
  /^artifact/i,
  /^show_artifact$/i,
  /^create_artifact$/i,
  /^preview(_artifact)?$/i,
  /^serve_artifact$/i,
  /^render_html$/i,
]

/**
 * Classify a tool call by name into 'diff' / 'bash' / 'artifact' / 'other'.
 * Returns null if `name` is missing.
 */
function classifyTool(name) {
  if (!name) return null
  const s = String(name)
  if (ARTIFACT_TOOL_PATTERNS.some((r) => r.test(s))) return 'artifact'
  if (DIFF_TOOL_PATTERNS.some((r) => r.test(s))) return 'diff'
  if (BASH_TOOL_PATTERNS.some((r) => r.test(s))) return 'bash'
  return 'other'
}

// -- event → signal -----------------------------------------------------------
//
// One session event may or may not produce a signal for the sliding window.
// Signals are cheap {kind, …} records; ratios are derived at aggregate time.

/**
 * Extract at most one signal from a SessionEvent. Returns null when the
 * event has nothing worth counting (e.g. request/header, step boundaries).
 */
function signalsFromEvent(event) {
  if (!event || typeof event.type !== 'string') return null
  const data = event.data || event
  const tsMs = event.time || 0
  switch (event.type) {
    case 'tool/call': {
      const cls = classifyTool(data.name)
      if (!cls) return null
      return { kind: 'tool', tool: cls, tsMs }
    }
    case 'tool/result': {
      // A result carrying an artifact render-intent promotes even when the
      // tool name itself was neutral. Same channel as widgets (see
      // docs/widget-channel-design.md) — the artifact card is another
      // branch, we just watch for the marker.
      const meta = data && data.meta
      if (meta && (meta.card === 'artifact' ||
          (meta.widget && meta.widget.kind === 'artifact'))) {
        return { kind: 'tool', tool: 'artifact', tsMs }
      }
      return null
    }
    case 'assistant/chunk': {
      const chunk = (data && data.chunk) || event.chunk
      if (!chunk || typeof chunk.text !== 'string') return null
      if (chunk.type === 'reasoning-delta') {
        return { kind: 'reasoning', charCount: chunk.text.length, tsMs }
      }
      if (chunk.type === 'text-delta') {
        return { kind: 'text', charCount: chunk.text.length, tsMs }
      }
      return null
    }
    case 'turn/start':
      return { kind: 'turn-start', tsMs }
    case 'turn/end':
      return { kind: 'turn-end', tsMs }
    default:
      return null
  }
}

// -- window aggregate ---------------------------------------------------------

/**
 * Fold a signal array into a stats object with the ratios computeHint reads.
 * Empty input yields zeros — callers should treat that as "no signal yet".
 */
function aggregate(signals) {
  let diffTools = 0, bashTools = 0, otherTools = 0, artifactTools = 0
  let reasoningChars = 0, textChars = 0
  let turnStarts = 0, turnEnds = 0
  let firstTsMs = Infinity, lastTsMs = 0
  for (const s of signals || []) {
    if (!s) continue
    if (s.tsMs) {
      if (s.tsMs < firstTsMs) firstTsMs = s.tsMs
      if (s.tsMs > lastTsMs) lastTsMs = s.tsMs
    }
    switch (s.kind) {
      case 'tool':
        if (s.tool === 'diff') diffTools++
        else if (s.tool === 'bash') bashTools++
        else if (s.tool === 'artifact') artifactTools++
        else otherTools++
        break
      case 'reasoning': reasoningChars += (s.charCount || 0); break
      case 'text':      textChars      += (s.charCount || 0); break
      case 'turn-start': turnStarts++; break
      case 'turn-end':   turnEnds++;   break
    }
  }
  const totalTools = diffTools + bashTools + otherTools + artifactTools
  const totalChars = reasoningChars + textChars
  return {
    diffTools, bashTools, otherTools, artifactTools,
    reasoningChars, textChars,
    turnStarts, turnEnds,
    totalTools, totalChars,
    diffToolRatio: totalTools ? diffTools / totalTools : 0,
    bashToolRatio: totalTools ? bashTools / totalTools : 0,
    artifactToolRatio: totalTools ? artifactTools / totalTools : 0,
    reasoningRatio: totalChars ? reasoningChars / totalChars : 0,
    windowSpanMs: firstTsMs === Infinity ? 0 : lastTsMs - firstTsMs,
    empty: totalTools === 0 && totalChars === 0 && turnStarts === 0 && turnEnds === 0,
  }
}

// -- pure decision function --------------------------------------------------

const DEFAULTS = Object.freeze({
  diffRatioMin: 0.35,      // fraction of window tool calls that must be edits
  diffToolsMin: 2,         // absolute floor so a single edit doesn't count
  bashRatioMin: 0.4,       // for monitor
  bashToolsMin: 3,
  monitorWindowMs: 15000,  // OR running=true satisfies the "long" gate
})

/**
 * Given a full-window aggregate, a recent-slice aggregate, and session
 * meta, decide which layout bucket to sit in. Priority order (top wins):
 *   artifact > code-review > monitor > chat.
 *
 * `recent` guards priority-1 (artifact) so a stale artifact from many
 * turns ago doesn't pin the UI open.
 */
function computeHint(full, recent, meta, opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) }
  meta = meta || {}
  if (!full || full.empty) return 'chat'

  // 1. artifact — recent-only; any artifact activity in the last slice wins.
  if (recent && recent.artifactTools > 0) return 'artifact'

  // 2. code-review — diff-heavy tool usage over the full window.
  if (full.totalTools >= cfg.diffToolsMin &&
      full.diffTools >= cfg.diffToolsMin &&
      full.diffToolRatio >= cfg.diffRatioMin) {
    return 'code-review'
  }

  // 3. monitor — bash-heavy and the turn is either actively running or
  //    the window covers more than a short burst.
  const isLong = meta.running === true || full.windowSpanMs >= cfg.monitorWindowMs
  if (isLong &&
      full.bashTools >= cfg.bashToolsMin &&
      full.bashToolRatio >= cfg.bashRatioMin) {
    return 'monitor'
  }

  return 'chat'
}

// -- stateful tracker --------------------------------------------------------

const LAYOUTS = Object.freeze(['chat', 'code-review', 'artifact', 'monitor'])

/**
 * Stream-oriented wrapper: keeps a sliding signal window, applies the
 * pure heuristic, and only reports a hint change after N consecutive
 * proposals agree. `lock(hint)` freezes the reported hint regardless
 * of incoming signals; `unlock()` re-enables auto behavior.
 */
class LayoutHintTracker {
  constructor(opts = {}) {
    this.windowSize = opts.windowSize || 40   // full window (older signals age out)
    this.recentSize = opts.recentSize || 10   // recent slice (artifact gate)
    this.stability = Math.max(1, opts.stability || 3)
    this.thresholds = opts.thresholds || {}
    this.signals = []
    this.candidate = null
    this.candidateCount = 0
    this.stable = 'chat'
    this.locked = null
    this.meta = {}
  }

  /** Merge in session-level meta (title, cwd, model, running, …). */
  setMeta(meta) {
    if (meta && typeof meta === 'object') this.meta = { ...this.meta, ...meta }
  }

  /** Freeze the hint. Any string is accepted; unknown values still latch. */
  lock(hint) {
    if (typeof hint !== 'string') return
    this.locked = hint
    // Snap `stable` too so currentHint() is consistent whether locked or not.
    this.stable = hint
    this.candidate = null
    this.candidateCount = 0
  }

  unlock() { this.locked = null }
  isLocked() { return this.locked !== null }
  currentHint() { return this.locked !== null ? this.locked : this.stable }

  /** Drop all accumulated signal state (call when switching sessions). */
  reset() {
    this.signals = []
    this.candidate = null
    this.candidateCount = 0
    if (this.locked === null) this.stable = 'chat'
  }

  /**
   * Feed one session event. Returns `{ hint, changed, stats }` where
   * `changed` flips true on the push that promotes the candidate.
   */
  push(event) {
    const s = signalsFromEvent(event)
    if (s) {
      this.signals.push(s)
      if (this.signals.length > this.windowSize) this.signals.shift()
    }

    // Locked: never re-evaluate.
    if (this.locked !== null) {
      return { hint: this.locked, changed: false, stats: aggregate(this.signals) }
    }

    const full = aggregate(this.signals)
    const recent = aggregate(this.signals.slice(-this.recentSize))
    const proposed = computeHint(full, recent, this.meta, this.thresholds)

    let changed = false
    if (proposed === this.stable) {
      // Any drift back to the current bucket resets pending debounce.
      this.candidate = null
      this.candidateCount = 0
    } else if (this.candidate === proposed) {
      this.candidateCount++
      if (this.candidateCount >= this.stability) {
        this.stable = proposed
        this.candidate = null
        this.candidateCount = 0
        changed = true
      }
    } else {
      this.candidate = proposed
      this.candidateCount = 1
    }
    return { hint: this.stable, changed, stats: full }
  }
}

// -- exports -----------------------------------------------------------------

const api = {
  classifyTool,
  signalsFromEvent,
  aggregate,
  computeHint,
  LayoutHintTracker,
  LAYOUTS,
  DEFAULTS,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.LayoutHeuristics = api
})()
