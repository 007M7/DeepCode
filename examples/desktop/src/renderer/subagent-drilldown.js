// Pure projections for the subagent drill-down tabs (lane-ctx-deep, F4).
//
// Each subagent card gets two tabs at its foot: "Tool defs" (what the
// child was allowed to call at startup) and "Inbound query" (the seed
// prompt the parent handed over). The renderer already has both of these
// buried inside the events array — this module surfaces them as a
// stable-shape view model the DOM builder plops into a tab shell.
//
// Tool defs source order:
//   1. `spec.toolDefs` — explicit array from a synthetic wire event.
//   2. Unique names from all `tool/call` events in `spec.childEvents`.
//      This is what today's fixtures ship; we tag each entry with a
//      `firstSeq` so a reader can trace where the child first used it.
//
// Inbound query source order:
//   1. `spec.parentQuery` — string or ContentBlock[] passed directly.
//   2. The first `user/message` in `spec.childEvents` (whose `source` is
//      `{kind:'plugin', plugin:'subagent-*'}` when the parent auto-seeds
//      the child; older fixtures just use a plain user/message).
//
// The returned shape is:
//   {
//     toolDefs: [
//       { name, firstSeq, sampleArgs, source: 'explicit'|'inferred' }
//     ],
//     toolDefsSource: 'explicit'|'inferred'|'empty',
//     inboundQuery: {
//       text,               // one-string preview
//       blocks,             // full ContentBlock[] when available, else null
//       source: 'explicit'|'seed-event'|'empty',
//       seq,                // seq of the seed event, or null
//     },
//   }
//
// Pure module. Tests in test/subagent-drilldown.test.js.

'use strict'

function textFromBlocks(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

function collectToolDefsFromEvents(childEvents) {
  const map = new Map()
  if (!Array.isArray(childEvents)) return { list: [], seen: 0 }
  for (const ev of childEvents) {
    if (!ev || ev.type !== 'tool/call') continue
    const name = ev.data && ev.data.name
    if (typeof name !== 'string' || !name) continue
    if (!map.has(name)) {
      const seq = Number.isFinite(ev.seq) ? ev.seq : 0
      const args = ev.data.arguments
      let sample = null
      if (typeof args === 'string' && args.length > 0) {
        sample = args.length > 100 ? args.slice(0, 97) + '…' : args
      } else if (args && typeof args === 'object') {
        try {
          const j = JSON.stringify(args)
          sample = j.length > 100 ? j.slice(0, 97) + '…' : j
        } catch (_) { sample = null }
      }
      map.set(name, { name, firstSeq: seq, sampleArgs: sample, source: 'inferred' })
    }
  }
  return { list: Array.from(map.values()), seen: map.size }
}

function normaliseExplicitToolDefs(toolDefs) {
  if (!Array.isArray(toolDefs)) return []
  const out = []
  for (const t of toolDefs) {
    if (typeof t === 'string') {
      out.push({ name: t, firstSeq: 0, sampleArgs: null, source: 'explicit' })
    } else if (t && typeof t.name === 'string') {
      out.push({
        name: t.name,
        firstSeq: Number.isFinite(t.firstSeq) ? t.firstSeq : 0,
        sampleArgs: (typeof t.sampleArgs === 'string' && t.sampleArgs) || null,
        source: 'explicit',
      })
    }
  }
  return out
}

function findSeedUserMessage(childEvents) {
  if (!Array.isArray(childEvents)) return null
  // The daemon seeds the child's turn 0 with a user/message whose source is
  // the parent subagent plugin. Fall back to the FIRST user/message if no
  // plugin-tagged one exists.
  let seedPlugin = null
  let seedFirst = null
  for (const ev of childEvents) {
    if (!ev || ev.type !== 'user/message') continue
    if (seedFirst === null) seedFirst = ev
    const src = ev.data && ev.data.source
    if (src && src.kind === 'plugin' && typeof src.plugin === 'string' && src.plugin.startsWith('subagent')) {
      seedPlugin = ev
      break
    }
  }
  return seedPlugin || seedFirst
}

/**
 * @param {object} spec
 * @param {Array<object>} [spec.childEvents]
 * @param {Array<string|{name:string}>} [spec.toolDefs]
 * @param {string|Array<object>} [spec.parentQuery]
 * @returns {{
 *   toolDefs: Array<{name:string, firstSeq:number, sampleArgs:string|null, source:'explicit'|'inferred'}>,
 *   toolDefsSource: 'explicit'|'inferred'|'empty',
 *   inboundQuery: { text:string, blocks: Array<object>|null, source: 'explicit'|'seed-event'|'empty', seq: number|null },
 * }}
 */
function buildSubagentDrilldown(spec) {
  const s = spec || {}
  let toolDefs = normaliseExplicitToolDefs(s.toolDefs)
  let toolDefsSource = toolDefs.length > 0 ? 'explicit' : 'empty'
  if (toolDefs.length === 0) {
    const { list } = collectToolDefsFromEvents(s.childEvents)
    if (list.length > 0) {
      toolDefs = list
      toolDefsSource = 'inferred'
    }
  }

  // Inbound query.
  let inboundText = ''
  let inboundBlocks = null
  let inboundSource = 'empty'
  let inboundSeq = null
  if (s.parentQuery !== undefined && s.parentQuery !== null) {
    if (typeof s.parentQuery === 'string') {
      inboundText = s.parentQuery
    } else if (Array.isArray(s.parentQuery)) {
      inboundBlocks = s.parentQuery
      inboundText = textFromBlocks(s.parentQuery)
    }
    if (inboundText) inboundSource = 'explicit'
  }
  if (!inboundText) {
    const seed = findSeedUserMessage(s.childEvents)
    if (seed && seed.data) {
      inboundBlocks = Array.isArray(seed.data.content) ? seed.data.content : null
      inboundText = textFromBlocks(seed.data.content)
      inboundSource = 'seed-event'
      inboundSeq = Number.isFinite(seed.seq) ? seed.seq : null
    }
  }

  return {
    toolDefs,
    toolDefsSource,
    inboundQuery: {
      text: inboundText,
      blocks: inboundBlocks,
      source: inboundSource,
      seq: inboundSeq,
    },
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildSubagentDrilldown, textFromBlocks }
}
if (typeof window !== 'undefined') {
  window.__dshSubagentDrilldown = { buildSubagentDrilldown, textFromBlocks }
}
