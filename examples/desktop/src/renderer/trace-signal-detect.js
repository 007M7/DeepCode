// trace-signal-detect.js — heuristic detector for "trace signals" that a
// researcher wants highlighted in the trace tri-view + the main assistant
// stream. This is a renderer-side workaround for a gap in the runtime wire:
// the SDK does not (yet) emit `type: 'trace/signal'` events, so we scan the
// event stream ourselves and mark four kinds of interesting nodes.
//
// See docs/upstream-ledger.md L-2 for the RFC that would remove this file
// from the critical path — once upstream emits real signal events, this
// module becomes dead code (the DOM overlay path already checks `_wireSignal`
// first and only falls back to detected signals when the wire is silent).
//
// The four signal kinds:
//
//   loop-detected   — >= N consecutive tool/call events with the same tool
//                     name AND the same args-prefix. Default N = 3.
//                     Reported on the SECOND repeat's seq (so a reader sees
//                     the badge as soon as the loop becomes suspicious).
//   redundant-call  — a tool/call whose (name, args-prefix) exactly matches
//                     a call within the last WINDOW seqs. Default WINDOW = 8.
//                     A true duplicate is often benign (retries, polling),
//                     but a researcher wants it flagged because it's the
//                     shape of accidental re-work. Not reported when the
//                     loop-detected badge already covers the same seq.
//   plan-update     — assistant/message text mentions a new plan (keywords:
//                     "new plan", "revised plan", "updated plan", "here's the
//                     plan", "plan:", numbered "1." at line start). Heuristic
//                     — never claimed to be authoritative. The DOM overlay
//                     surfaces the badge with an "heuristic" tooltip.
//   plan-restart    — the same tool retried after a tool/result error
//                     (ok:false). Signals "the plan is being restarted after
//                     a failure" — often the first place a reader wants to
//                     look when debugging a stuck agent.
//   tool-error      — tool/result with ok:false. Already visible via the ✗
//                     glyph, but we surface a red badge on Timeline/Graph so
//                     a full-session view has the error nodes stand out.
//
// The detector is pure: it takes `events` (a flat array from
// session.cachedEvents), returns `{ bySeq: Map<seq, Signal[]>, all: Signal[] }`.
// Each Signal is { signal, seq, meta } where `meta` names the offending
// tools / prior seqs / snippet so the tooltip can be informative.
//
// Deliberately lightweight — no dep on trace-aggregator so the detector
// can run on raw wire without step boundaries.

'use strict'

;(function () {
  const DEFAULT_LOOP_N = 3
  const DEFAULT_REDUNDANT_WINDOW = 8
  const PLAN_KEYWORDS = [
    'new plan',
    'revised plan',
    'updated plan',
    'here\'s the plan',
    'here is the plan',
    'the plan is now',
    'let me revise',
    'let me update the plan',
  ]

  function detectSignals(events, opts) {
    const options = opts || {}
    const loopN = Number.isFinite(options.loopN) && options.loopN >= 2 ? options.loopN : DEFAULT_LOOP_N
    const window = Number.isFinite(options.window) && options.window >= 2 ? options.window : DEFAULT_REDUNDANT_WINDOW
    const list = Array.isArray(events) ? events : []
    const all = []
    const bySeq = new Map()

    // Wire-pass first: if any event is already a signal from the runtime
    // (post-RFC L-2), consume it verbatim and skip heuristic detection for
    // that seq. Keeps this module a no-op once upstream lands the fix.
    for (const ev of list) {
      if (ev && ev.type === 'trace/signal' && ev.data && typeof ev.data.signal === 'string') {
        const sig = {
          signal: ev.data.signal,
          seq: typeof ev.seq === 'number' ? ev.seq : null,
          meta: Object.assign({ source: 'wire' }, ev.data),
        }
        emit(all, bySeq, sig)
      }
    }

    // Rolling window over tool/call events for loop + redundant detection.
    const recentCalls = [] // { seq, name, argsKey }
    let lastToolError = null // { seq, name, callId }

    for (let i = 0; i < list.length; i++) {
      const ev = list[i]
      if (!ev || typeof ev !== 'object') continue

      // Loop / redundant — tool/call ordering
      if (ev.type === 'tool/call') {
        const name = ev.data && typeof ev.data.name === 'string' ? ev.data.name : ''
        const argsKey = _argsKey(ev.data)
        const seq = typeof ev.seq === 'number' ? ev.seq : null
        const cur = { seq, name, argsKey, callId: ev.data && ev.data.callId }

        // loop-detected: look back at recentCalls tail for a run of
        // (name, argsKey) matches. When length >= loopN including cur,
        // flag cur's seq. Use `argsPrefix` (first 80 chars) so a call that
        // varies only in a trailing timestamp still matches.
        let run = 1
        for (let j = recentCalls.length - 1; j >= 0; j--) {
          const prev = recentCalls[j]
          if (prev.name === name && prev.argsKey === argsKey) run++
          else break
        }
        if (run >= loopN && seq !== null) {
          emit(all, bySeq, {
            signal: 'loop-detected',
            seq,
            meta: { source: 'heuristic', name, argsKey, run, priorSeqs: _lastNPriorSeqs(recentCalls, run - 1) },
          })
        }

        // redundant-call: exact (name, argsKey) match within the last N calls,
        // NOT counting the immediate consecutive run (that's loop-detected).
        // Only flag when there is at least one intervening different call, so
        // we don't double-flag a pure loop.
        if (seq !== null && run < loopN) {
          for (let j = recentCalls.length - 1; j >= 0 && recentCalls.length - j <= window; j--) {
            const prev = recentCalls[j]
            if (prev.name === name && prev.argsKey === argsKey && (recentCalls.length - 1 - j) >= 1) {
              // Ensure at least one call between prev and cur has a different key.
              let interleaved = false
              for (let k = j + 1; k < recentCalls.length; k++) {
                if (recentCalls[k].name !== name || recentCalls[k].argsKey !== argsKey) { interleaved = true; break }
              }
              if (interleaved) {
                emit(all, bySeq, {
                  signal: 'redundant-call',
                  seq,
                  meta: { source: 'heuristic', name, argsKey, priorSeq: prev.seq },
                })
                break
              }
            }
          }
        }

        // plan-restart: same tool re-invoked after a recent tool/result error.
        // Guard: current callId must differ from the errored one (a wire replay
        // of the same call shouldn't count as a restart).
        if (lastToolError && lastToolError.name === name && seq !== null
          && cur.callId !== lastToolError.callId) {
          emit(all, bySeq, {
            signal: 'plan-restart',
            seq,
            meta: { source: 'heuristic', name, priorErrorSeq: lastToolError.seq },
          })
          lastToolError = null
        }

        recentCalls.push(cur)
        // Cap window to keep the scan O(N) — recentCalls only needs to hold
        // the last `window` entries.
        if (recentCalls.length > window * 2) recentCalls.splice(0, recentCalls.length - window * 2)
        continue
      }

      // Tool errors
      if (ev.type === 'tool/result' && ev.data && ev.data.ok === false) {
        const seq = typeof ev.seq === 'number' ? ev.seq : null
        const name = ev.data && typeof ev.data.name === 'string' ? ev.data.name
          : _findCallName(list, ev.data && ev.data.callId)
        // Emit on the result seq AND the matching call seq. Timeline pairs
        // call+result into one bar keyed by the call's seq, and the Graph
        // absorbs the result into the call node — so the call seq is the
        // seq a reader actually sees. Result seq is kept for tree/detail
        // rendering that lists events individually.
        const callSeq = _findCallSeq(list, ev.data && ev.data.callId)
        const errorMeta = { source: 'wire', name, callId: ev.data.callId, error: ev.data.error || null }
        if (seq !== null) {
          emit(all, bySeq, { signal: 'tool-error', seq, meta: errorMeta })
        }
        if (callSeq !== null && callSeq !== seq) {
          emit(all, bySeq, { signal: 'tool-error', seq: callSeq, meta: errorMeta })
        }
        lastToolError = { seq, name, callId: ev.data && ev.data.callId }
        continue
      }

      // plan-update: assistant text mentioning "new plan" / "revised plan".
      if (ev.type === 'assistant/message') {
        const seq = typeof ev.seq === 'number' ? ev.seq : null
        const text = _assistantText(ev.data)
        if (seq !== null && _looksLikePlanUpdate(text)) {
          emit(all, bySeq, {
            signal: 'plan-update',
            seq,
            meta: { source: 'heuristic', snippet: _trim(text, 80) },
          })
        }
        continue
      }
    }

    return { bySeq, all }
  }

  function emit(all, bySeq, sig) {
    // Dedup: don't emit the same signal kind on the same seq twice.
    const list = bySeq.get(sig.seq) || []
    for (const prev of list) if (prev.signal === sig.signal) return
    list.push(sig)
    bySeq.set(sig.seq, list)
    all.push(sig)
  }

  function _argsKey(data) {
    if (!data) return ''
    // Prefer a stable JSON of the arguments; fall back to string coercion.
    // Truncate to 80 chars so we don't burn memory on huge blobs, and so
    // small trailing-timestamp diffs still coalesce.
    try {
      const raw = data.arguments != null ? data.arguments
        : data.args != null ? data.args : ''
      const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
      return _trim(String(s || ''), 80)
    } catch (_) {
      return _trim(String(data.arguments || data.args || ''), 80)
    }
  }

  function _assistantText(data) {
    if (!data) return ''
    if (Array.isArray(data.content)) {
      const parts = []
      for (const block of data.content) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      return parts.join('\n')
    }
    if (typeof data.text === 'string') return data.text
    return ''
  }

  function _looksLikePlanUpdate(text) {
    if (typeof text !== 'string' || !text) return false
    const lower = text.toLowerCase()
    for (const kw of PLAN_KEYWORDS) if (lower.includes(kw)) return true
    // Numbered plan intro: "1. …\n2. …" occurring in the first 200 chars.
    // Requires two adjacent numbered lines to reduce false positives from
    // enumerations inside prose.
    const head = text.slice(0, 400)
    const m = head.match(/(^|\n)\s*1\.\s.+\n\s*2\.\s/)
    if (m) return true
    return false
  }

  function _findCallName(events, callId) {
    if (!callId) return ''
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'tool/call' && ev.data && ev.data.callId === callId) {
        return typeof ev.data.name === 'string' ? ev.data.name : ''
      }
    }
    return ''
  }

  function _findCallSeq(events, callId) {
    if (!callId) return null
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'tool/call' && ev.data && ev.data.callId === callId
        && typeof ev.seq === 'number') return ev.seq
    }
    return null
  }

  function _lastNPriorSeqs(list, n) {
    const out = []
    for (let i = list.length - 1; i >= 0 && out.length < n; i--) {
      if (typeof list[i].seq === 'number') out.unshift(list[i].seq)
    }
    return out
  }

  function _trim(s, n) {
    if (typeof s !== 'string') return ''
    if (s.length <= n) return s
    return s.slice(0, n - 1) + '…'
  }

  // Given a step-record (or array of them from the aggregator), flatten
  // the outputs+inputs+events into one seq-ordered event list and detect.
  // Consumers on the tri-view side prefer this shape because they hold
  // records, not raw events.
  function detectSignalsFromRecords(records, opts) {
    const list = Array.isArray(records) ? records : (records ? [records] : [])
    const flat = []
    const seen = new Set()
    for (const rec of list) {
      if (!rec) continue
      for (const bucket of ['inputs', 'outputs', 'events']) {
        const arr = rec[bucket]
        if (!Array.isArray(arr)) continue
        for (const ev of arr) {
          if (!ev || typeof ev !== 'object') continue
          const key = typeof ev.seq === 'number' ? `s${ev.seq}` : `t${ev.type}|${flat.length}`
          if (seen.has(key)) continue
          seen.add(key)
          flat.push(ev)
        }
      }
    }
    flat.sort(function (a, b) {
      const sa = typeof a.seq === 'number' ? a.seq : Infinity
      const sb = typeof b.seq === 'number' ? b.seq : Infinity
      return sa - sb
    })
    return detectSignals(flat, opts)
  }

  // Human-readable label for a signal — used by tooltip helpers on both
  // Timeline/Graph badges and the main-flow chip.
  function labelFor(signal) {
    switch (signal) {
      case 'loop-detected': return 'Loop detected'
      case 'redundant-call': return 'Redundant call'
      case 'plan-update': return 'Plan update'
      case 'plan-restart': return 'Plan restart'
      case 'tool-error': return 'Tool error'
      default: return signal || 'Signal'
    }
  }

  // CSS class-name suffix — kept aligned with the badge styles in style.css.
  function classFor(signal) {
    switch (signal) {
      case 'loop-detected': return 'sig-loop'
      case 'redundant-call': return 'sig-redundant'
      case 'plan-update': return 'sig-plan'
      case 'plan-restart': return 'sig-plan-restart'
      case 'tool-error': return 'sig-error'
      default: return 'sig-generic'
    }
  }

  function tooltipFor(sig) {
    if (!sig) return ''
    const parts = [labelFor(sig.signal)]
    const m = sig.meta || {}
    if (sig.signal === 'loop-detected' && m.name) {
      parts.push(`${m.run || '?'} × ${m.name}`)
      if (Array.isArray(m.priorSeqs) && m.priorSeqs.length) {
        parts.push(`prior seq ${m.priorSeqs.join(', ')}`)
      }
    } else if (sig.signal === 'redundant-call' && m.name) {
      parts.push(`${m.name}, matches seq ${m.priorSeq}`)
    } else if (sig.signal === 'plan-update' && m.snippet) {
      parts.push(`“${m.snippet}”`)
    } else if (sig.signal === 'plan-restart' && m.name) {
      parts.push(`retry ${m.name} after seq ${m.priorErrorSeq}`)
    } else if (sig.signal === 'tool-error' && m.name) {
      parts.push(m.name + (m.error ? `: ${_trim(String(m.error), 60)}` : ''))
    }
    if (m.source === 'heuristic') parts.push('(heuristic)')
    return parts.join(' · ')
  }

  const api = {
    detectSignals,
    detectSignalsFromRecords,
    labelFor,
    classFor,
    tooltipFor,
    // Exposed for tests / diagnostics only.
    _internals: { _argsKey, _looksLikePlanUpdate },
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  }
  if (typeof window !== 'undefined') {
    window.__dshTraceSignalDetect = api
  }
})()
