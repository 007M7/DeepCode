// Mission Control — Topology subview. SVG rendering of the DAG the
// mission-model layout produced.
//
// Visual grammar (borrowed from Augur/prototype/LAYOUT.md, only the pattern —
// there's no embedding math here):
//   - Every root session is a "community". Descendants share the root's hue,
//     so the picture reads as N distinct trees, not one indistinct thicket.
//   - Node radius maps to importance: log(eventCount+1) clamped to 6-14 px.
//     Running nodes keep the pulsing halo on top of that.
//   - A legend row under the graph names each root family, dot swatch + count,
//     so the coloring is a key not a decoration.
//   - Edges are drawn in the child's family hue, thin and soft, active edges
//     picking up a dash-flow the CSS animates.
//
// Node interaction is unchanged from the earlier version: hover reveals a
// tooltip with title/model/event count/last summary; click invokes onSelect.
// Layout coordinates come from projectTopology(state); this module never
// computes positions.

'use strict'

;(function () {
  const NS = 'http://www.w3.org/2000/svg'

  // Family palette — six hues from the mission categorical set, plus fallbacks.
  // Picked to read well against a light background at low saturation, no neon.
  // Order matters: root #0 gets index 0, etc.; the palette wraps.
  const FAMILY_PALETTE = [
    '#2563eb', // accent blue
    '#0f766e', // teal-700
    '#a16207', // amber-700
    '#7c3aed', // violet-600
    '#b91c1c', // red-700
    '#059669', // emerald-600
    '#c026d3', // fuchsia-600
    '#4b5563', // slate-600 (fallback grey)
  ]

  function svg(name, attrs) {
    const el = document.createElementNS(NS, name)
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    return el
  }

  // Build a Map(sessionId → rootId) from the graph. Every rank-0 node is its
  // own root; every non-root inherits its parent's rootId by walking edges.
  // We rebuild locally so the view doesn't need model changes.
  function assignFamilies(graph) {
    const familyOf = new Map()
    const roots = graph.nodes.filter((n) => n.rank === 0)
    // Sort roots by lastEventTime desc so the most recent tree lands on the
    // stable end of the palette. Matches the projectTopology sort order.
    roots.sort((a, b) => (b.lastEventTime || 0) - (a.lastEventTime || 0))
    for (const r of roots) familyOf.set(r.sessionId, r.sessionId)
    // Walk edges — each is parent(from) → child(to). Propagate until no more
    // updates. Edge list is small (< a few hundred), one pass is enough for
    // the tree case; loop to catch out-of-order edges.
    let changed = true
    let guard = 0
    while (changed && guard < 8) {
      changed = false
      for (const e of graph.edges) {
        const parentFam = familyOf.get(e.from)
        if (parentFam && !familyOf.has(e.to)) {
          familyOf.set(e.to, parentFam)
          changed = true
        }
      }
      guard += 1
    }
    // Index each rootId into the palette.
    const colorOf = new Map()
    roots.forEach((r, i) => {
      colorOf.set(r.sessionId, FAMILY_PALETTE[i % FAMILY_PALETTE.length])
    })
    return { familyOf, colorOf, roots }
  }

  // Radius by importance: log(events+1) → [6,14]. Roots read slightly bigger
  // than leaves without dominating. Running state is layered on visually via
  // the pulsing halo, not by additional radius.
  function radiusFor(node) {
    const events = Math.max(0, node.eventCount || 0)
    const raw = Math.log2(events + 1) * 2 + 6
    return Math.max(6, Math.min(14, Math.round(raw)))
  }

  function shortLabel(title, sessionId) {
    const raw = String(title || '').trim() || sessionId.slice(0, 8)
    if (raw.length <= 20) return raw
    return raw.slice(0, 18) + '…'
  }

  // Pick which nodes get a `<text>` label. Every rank row is subject to a
  // collision check: sort by cross-axis position, then greedily build
  // clusters — a node joins the current cluster if it sits within `minPx`
  // of the previous one, otherwise it starts a new cluster. Each cluster
  // contributes exactly one labeled node: the one with the highest
  // eventCount (tie-broken by first-in-row). Unlabeled nodes still render
  // the dot + a native `<title>` tooltip, so hover disambiguates them; the
  // SVG just stops trying to name every dot when there's no room. Pure
  // function — no DOM access, safe to unit-test.
  //
  // NEW-4.a fix: the pass exempted rank-0
  // roots ("they anchor a family"), but the crush *is* the roots — 25+
  // smoke-tr sessions all root-rank, crammed across the top. Roots have to
  // collide like anyone else. Legend still names every family, so the
  // dropped labels aren't lost — they've just moved to the more-scannable
  // side card.
  function pickLabeledNodes(nodes, opts) {
    const kept = new Set()
    if (!Array.isArray(nodes) || nodes.length === 0) return kept
    const width = (opts && opts.width) || 1000
    const minPx = (opts && opts.minPx) || 60
    const orientation = opts && opts.orientation === 'horizontal' ? 'horizontal' : 'vertical'
    const cross = orientation === 'vertical' ? 'x' : 'y'
    // Group by rank so we only check collisions within a row.
    const byRank = new Map()
    for (const n of nodes) {
      const rk = n.rank || 0
      if (!byRank.has(rk)) byRank.set(rk, [])
      byRank.get(rk).push(n)
    }
    // Fixed-width bucketing along the cross axis. Each bucket of minPx
    // width contributes one labeled node — the one with the highest
    // eventCount in the bucket. This gives a hard ceiling of `width/minPx`
    // labels per rank row regardless of how densely packed the nodes are.
    // Bucketing (rather than chained "within minPx of last") prevents an
    // evenly-spaced 25-root row from collapsing into a single label just
    // because every consecutive gap is below the threshold.
    for (const [, row] of byRank) {
      row.sort((a, b) => (a[cross] || 0) - (b[cross] || 0))
      const perBucket = new Map()
      for (const n of row) {
        const px = (n[cross] || 0) * width
        const bucket = Math.floor(px / minPx)
        const prev = perBucket.get(bucket)
        if (!prev || (n.eventCount || 0) > (prev.eventCount || 0)) {
          perBucket.set(bucket, n)
        }
      }
      for (const n of perBucket.values()) kept.add(n.sessionId)
    }
    return kept
  }

  function createMissionTopoView(root, deps) {
    const onSelect = (deps && deps.onSelect) || (() => {})
    root.classList.add('mission-topo')

    const tip = document.createElement('div')
    tip.className = 'mission-topo-tip'
    tip.hidden = true

    let width = 0
    let height = 0
    function measure() {
      const r = root.getBoundingClientRect()
      width = Math.max(320, r.width)
      height = Math.max(360, Math.min(720, r.height || 480))
    }

    function render(graph) {
      root.innerHTML = ''
      measure()
      const unlinked = (graph && graph.unlinked) || []
      if (!graph || graph.nodes.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'mission-empty'
        const head = document.createElement('div')
        head.className = 'mission-empty-title'
        head.textContent = 'No multi-agent runs yet'
        const sub = document.createElement('div')
        sub.className = 'mission-empty-sub'
        sub.textContent = unlinked.length > 0
          ? `${unlinked.length} unlinked session${unlinked.length === 1 ? '' : 's'} so far. The graph draws itself once sessions fork or spawn subagents.`
          : 'Once a session forks or spawns a subagent, the graph will appear here.'
        empty.append(head, sub)
        root.appendChild(empty)
        return
      }

      // ---- family coloring & legend prep ---------------------------------
      const { familyOf, colorOf, roots } = assignFamilies(graph)
      const countByRoot = new Map()
      for (const n of graph.nodes) {
        const r = familyOf.get(n.sessionId) || n.sessionId
        countByRoot.set(r, (countByRoot.get(r) || 0) + 1)
      }

      // ---- SVG -----------------------------------------------------------
      // NEW-4.b fix (2026-07-16): the legend is now an in-SVG overlay at the
      // bottom-left instead of an HTML sibling. When the container was tall
      // enough to fit the graph but the viewport was only 900 px, the HTML
      // row got pushed off-screen. An SVG-internal foreignObject sits inside
      // the drawing surface so it always renders within the visible area.
      // Reserve a slim band at the bottom of the plot area so labels/nodes
      // don't fight the legend card for space.
      const legendReserveH = 44
      const drawH = height - legendReserveH
      const s = svg('svg', {
        viewBox: `0 0 ${width} ${height}`,
        width: '100%', height: String(height),
        class: 'mission-topo-svg',
      })
      const gRoot = svg('g')
      s.appendChild(gRoot)

      const project = (n) => ({ x: n.x * width, y: n.y * drawH })
      // Which node ids get a <text> label. Density threshold: 96 px between
      // labels on the same rank row — center-anchored text at 11px font can
      // spill ~40-50px each side of the dot for a 12-16 char short label,
      // so anything under ~90px causes visible overlap. Unlabeled nodes
      // still render dots + <title> tooltips + hover cards; the legend
      // overlay carries every family name so a dropped label is not lost.
      const labeled = pickLabeledNodes(graph.nodes, {
        width, orientation: graph.orientation || 'vertical', minPx: 96,
      })

      // Edges first so nodes render above.
      const gEdges = svg('g', { class: 'edges' })
      for (const e of graph.edges) {
        const from = project({ x: e.fromX, y: e.fromY })
        const to = project({ x: e.toX, y: e.toY })
        const dx = to.x - from.x
        const dy = to.y - from.y
        const orient = graph.orientation || 'vertical'
        const c1 = orient === 'vertical'
          ? { x: from.x, y: from.y + dy * 0.5 }
          : { x: from.x + dx * 0.5, y: from.y }
        const c2 = orient === 'vertical'
          ? { x: to.x, y: to.y - dy * 0.5 }
          : { x: to.x - dx * 0.5, y: to.y }
        // Family colour on the edge — the child's family is always its
        // parent's, so either endpoint works.
        const fam = familyOf.get(e.to) || familyOf.get(e.from)
        const stroke = colorOf.get(fam) || 'var(--border)'
        const path = svg('path', {
          d: `M ${from.x},${from.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`,
          class: 'mission-topo-edge' + (e.active ? ' active' : ''),
          stroke,
        })
        gEdges.appendChild(path)
      }
      gRoot.appendChild(gEdges)

      // Nodes.
      const gNodes = svg('g', { class: 'nodes' })
      for (const n of graph.nodes) {
        const p = project(n)
        const fam = familyOf.get(n.sessionId) || n.sessionId
        const color = colorOf.get(fam) || 'var(--muted)'
        const r = radiusFor(n)
        const grp = svg('g', {
          class: 'mission-topo-node' + (n.running ? ' running' : ''),
          transform: `translate(${p.x}, ${p.y})`,
          'data-session-id': n.sessionId,
          'data-family': fam,
        })
        if (n.running) grp.appendChild(svg('circle', { class: 'halo', r: r + 6, stroke: color }))
        // Colored ring + soft interior. Kept in the family hue so a tree
        // reads as one visual unit at a glance.
        grp.appendChild(svg('circle', {
          class: 'dot',
          r,
          fill: `color-mix(in oklab, ${color} 18%, var(--bg))`,
          stroke: color,
        }))
        // Native SVG title on every node so hover always shows the full name
        // — the tooltip below is fancier but this covers touch and keyboard
        // focus, and it's the only affordance an unlabeled node has.
        const nativeTitle = svg('title')
        nativeTitle.textContent = n.title || n.sessionId
        grp.appendChild(nativeTitle)
        // Only draw a text label if pickLabeledNodes cleared this node. When
        // N > ~25 roots crowd the top row, or leaves pack too tightly in a
        // rank row, the label would overlap the neighbour and turn into
        // `smoke-tsmoke-ts…` — omitting it is quieter than smearing.
        if (labeled.has(n.sessionId)) {
          const label = svg('text', {
            class: 'label',
            x: graph.orientation === 'horizontal' ? r + 6 : 0,
            y: graph.orientation === 'horizontal' ? 4 : r + 14,
            'text-anchor': graph.orientation === 'horizontal' ? 'start' : 'middle',
          })
          label.textContent = shortLabel(n.title, n.sessionId)
          grp.appendChild(label)
        }

        grp.addEventListener('mouseenter', (ev) => {
          const rect = root.getBoundingClientRect()
          tip.innerHTML = ''
          const h = document.createElement('div')
          h.className = 'mission-topo-tip-title'
          h.textContent = n.title || n.sessionId.slice(0, 8)
          tip.appendChild(h)
          const meta = document.createElement('div')
          meta.className = 'mission-topo-tip-meta'
          const bits = [
            n.model ? `model ${n.model}` : null,
            `${n.eventCount} events`,
            n.running ? 'running' : 'idle',
          ].filter(Boolean)
          meta.textContent = bits.join(' · ')
          tip.appendChild(meta)
          if (n.lastEventSummary) {
            const s2 = document.createElement('div')
            s2.className = 'mission-topo-tip-sub'
            s2.textContent = n.lastEventSummary
            tip.appendChild(s2)
          }
          tip.style.left = (ev.clientX - rect.left + 12) + 'px'
          tip.style.top = (ev.clientY - rect.top + 12) + 'px'
          tip.hidden = false
        })
        grp.addEventListener('mouseleave', () => { tip.hidden = true })
        grp.addEventListener('click', (ev) => {
          ev.stopPropagation()
          onSelect(n.sessionId)
        })
        gNodes.appendChild(grp)
      }
      gRoot.appendChild(gNodes)

      // ---- legend overlay -----------------------------------------------
      // Bottom-left in-SVG card: dot + root title + node count, one entry
      // per family. Lives inside the SVG viewport (via <foreignObject>) so
      // it never falls below the fold — the old HTML sibling was pushed
      // off-screen at 900 px viewports (NEW-4.b, 2026-07-16). Widthcap +
      // internal scroll so a huge root count doesn't overrun the plot.
      if (roots.length > 0) {
        const legendW = Math.min(340, Math.max(220, Math.floor(width * 0.42)))
        const legendCardH = 40 // fixed pill height; scroll inside if roots overflow
        const fo = svg('foreignObject', {
          x: 8,
          y: height - legendCardH - 6,
          width: legendW,
          height: legendCardH,
          class: 'mission-topo-legend-fo',
        })
        const legend = document.createElement('div')
        legend.className = 'mission-topo-legend mission-topo-legend-overlay'
        for (const r of roots) {
          const item = document.createElement('span')
          item.className = 'mission-topo-legend-item'
          item.dataset.family = r.sessionId
          const swatch = document.createElement('span')
          swatch.className = 'mission-topo-legend-swatch'
          swatch.style.background = colorOf.get(r.sessionId) || 'var(--muted)'
          const label = document.createElement('span')
          label.className = 'mission-topo-legend-label'
          label.textContent = shortLabel(r.title, r.sessionId)
          const count = document.createElement('span')
          count.className = 'mission-topo-legend-count'
          count.textContent = ' · ' + (countByRoot.get(r.sessionId) || 1)
          item.append(swatch, label, count)
          item.addEventListener('click', (ev) => {
            ev.stopPropagation()
            onSelect(r.sessionId)
          })
          legend.appendChild(item)
        }
        fo.appendChild(legend)
        s.appendChild(fo)
      }
      root.appendChild(s)

      root.appendChild(tip)
    }

    return { render }
  }

  const api = { createMissionTopoView,
    // Exposed for unit tests. The pure helpers cover the branchy bits
    // (family propagation across edges, radius clamps, label ellipsize) so
    // the DOM view above can stay untested.
    _internal: { assignFamilies, radiusFor, shortLabel, FAMILY_PALETTE, pickLabeledNodes } }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof globalThis !== 'undefined') globalThis.MissionTopo = api
})()
