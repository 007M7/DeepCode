// Nav structure static gate (task #189). The three-group left-nav is a
// coordination point for four parallel lanes — context / hub / bench /
// rubrics each swap one `data-lane="pending"` button for a wired one.
// If a lane inadvertently rewrites the whole nav (or a merge conflict
// erases a group header), this gate fails loudly. It's a shape test,
// not a screenshot test — the CDP shots in docs/demo-shots cover the
// visual side.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/index.html'),
  'utf8'
)

test('sidebar declares three activity groups plus admin', () => {
  const groups = HTML.match(/data-nav-group="([^"]+)"/g) || []
  const names = groups.map((m) => m.match(/data-nav-group="([^"]+)"/)[1])
  // Order matters: observation first (scanning), iteration second
  // (making), runtime last (managing). Admin lives after the trio.
  assert.deepStrictEqual(names, ['observation', 'iteration', 'runtime', 'admin'])
})

test('no lane still carries pending — all four slots flipped', () => {
  // Merge history: bench flipped at BENCH merge; context flipped at CTX
  // merge; hub + rubrics flipped at NAV delta merge (per team-lead rule
  // "each slot flips in its own lane's merge — since neither HUB nor RUB
  // touched index.html on their merge path, and NAV delta is the first
  // merge after HUB/RUB that DOES touch index.html for a related reason,
  // their attr flip is bundled into NAV delta"). The whole four-lane
  // pending-slot coordination is now closed; if a future lane needs a
  // reserved slot, add a fresh comment block and reintroduce the assert.
  const lines = HTML.split('\n')
  const buttonPending = lines.filter((l) => /<button[^>]*data-lane="pending"/.test(l))
  assert.strictEqual(buttonPending.length, 0,
    `all four coordinated slots should be flipped (found ${buttonPending.length} still-pending)`)
})

test('Runtimes surface preserved inside the Evals pane', () => {
  // Post lane-evals-merge (2026-07-19), Runtimes is a tab inside the
  // Evals door, not its own top-level nav. The nav button is 'evals';
  // the runtimes-pane id + data-pane="runtimes" stay because
  // runtimes-page.js queries them by that selector.
  assert.match(HTML, /data-tab="evals"/, 'Evals nav button missing')
  assert.match(HTML, /data-pane="runtimes"/, 'runtimes sub-pane still keeps its data-pane hook')
  assert.match(HTML, /id="runtimes-pane"/, 'runtimes-pane id preserved for runtimes-page.js binding')
  assert.match(HTML, /data-evals-tab-pane="runtime"/, 'Runtime tab pane marker present')
})

test('Evals door hosts Rubrics/Growth/Runtime as tabs', () => {
  // Sanity: the three sub-pane markers are present and reachable via
  // their evals-tab id. Guards against a future edit that silently
  // orphans a tab pane.
  assert.match(HTML, /data-evals-tab="rubrics"/, 'Rubrics tab button present')
  assert.match(HTML, /data-evals-tab="growth"/, 'Growth tab button present')
  assert.match(HTML, /data-evals-tab="runtime"/, 'Runtime tab button present')
  assert.match(HTML, /data-evals-tab-pane="rubrics"/, 'Rubrics tab pane present')
  assert.match(HTML, /data-evals-tab-pane="growth"/, 'Growth tab pane present')
  assert.match(HTML, /data-evals-tab-pane="runtime"/, 'Runtime tab pane present')
  assert.match(HTML, /id="evals-shared-rubric"/, 'Shared rubric selector present')
})

test('Settings tab and pane exist', () => {
  assert.match(HTML, /data-tab="settings"/)
  assert.match(HTML, /data-pane="settings"/)
  assert.match(HTML, /id="settings-pane"/)
})

test('Tracing tab and pane exist (#225 lane-tracing slot)', () => {
  // Lane-tracing slot lives in the `observation` group next to Chat /
  // Session Tree / Context. The button is a plain `data-tab="tracing"`
  // (no data-lane="pending" fence — landed live in the lane-tracing
  // merge, same pattern as the context slot). Pane is `data-pane
  // ="tracing"`, hosting the reference tracing UI-style project runs table. This
  // gate protects the wire so a future left-nav reshuffle doesn't
  // silently orphan the Tracing surface.
  assert.match(HTML, /data-tab="tracing"/, 'Tracing sidebar button missing')
  assert.match(HTML, /data-pane="tracing"/, 'Tracing pane section missing')
  // The observation group bumps to 4 items when Tracing lands (Chat,
  // Session Tree, Context, Tracing). If a lane inadvertently drops it
  // back to 3, this fails loudly.
  assert.match(
    HTML,
    /data-nav-group="observation"\s+data-item-count="4"/,
    'observation group data-item-count must be 4 with Tracing in place'
  )
})

test('Missions retitle landed (both header + sidebar label)', () => {
  // Nav label
  assert.match(HTML, /<span>Missions<\/span>/)
  // Pane page-title
  assert.match(HTML, /<div class="page-title">Missions<\/div>/)
  // Sidebar section-label
  assert.match(HTML, /<span class="section-label">Missions<\/span>/)
})

test('Sample-trace button + fixture exist', () => {
  assert.match(HTML, /id="empty-load-sample-trace"/)
  const fixturePath = path.resolve(__dirname, '..', 'fixtures/trace-samples/sample-session.json')
  assert.ok(fs.existsSync(fixturePath), 'sample-session.json fixture must exist')
  const events = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  assert.ok(Array.isArray(events), 'fixture is a JSON array')
  assert.ok(events.length >= 60, 'fixture holds a multi-turn session (>=60 events)')
})

test('Rec 29 revision: empty-state launcher offers the four canonical doors', () => {
  // User ruling 2026-07-17 ("两种风格重复了，只保留一种"): the empty
  // state was collapsed from 8 cards (4 vertical launcher + 4 horizontal
  // prompt-chip) down to a single 4-card horizontal row. Door set was
  // reprioritized around "everything is a plugin" and context/tracing
  // as the DSH differentiators:
  //   • vibe-plugin  — Have the agent write a plugin (C-slot)
  //   • context      — Explore context & composition
  //   • try-chat     — Try a chat
  //   • sample-trace — See a full trace (loads fixture + jumps Tracing)
  // Retired from the empty state (still reachable via left-nav):
  // bench, growth. This test guards the door set so any future rename
  // lands here first and forces the renderer branch to move in lockstep.
  assert.match(HTML, /data-empty-launcher/, 'launcher container marker present')
  for (const which of ['vibe-plugin', 'context', 'try-chat', 'sample-trace']) {
    const re = new RegExp(`data-launcher="${which}"`)
    assert.match(HTML, re, `launcher card for "${which}" missing`)
  }
  // Retired doors must NOT appear as launcher entries — they add
  // scroll and dilute the "plugin + context + tracing" story. Their
  // nav-item buttons in the sidebar are unaffected.
  for (const which of ['bench', 'growth']) {
    const re = new RegExp(`data-launcher="${which}"`)
    assert.doesNotMatch(HTML, re, `retired launcher card for "${which}" must be removed`)
  }
})

test('Rec 30: API keys table declares the resource-schema columns', () => {
  // Column order matches reference tracing UI Settings > API Keys:
  //   Name / Tier / Description / Presence / Last used
  assert.match(HTML, /data-settings-keys-table/, 'keys resource table present')
  assert.match(HTML, /data-settings-keys-tbody/, 'keys tbody hook present')
  // Header cells in order — grabs the first <thead> under the keys table.
  const tableMatch = HTML.match(/<table[^>]*data-settings-keys-table[\s\S]*?<\/table>/)
  assert.ok(tableMatch, 'keys table block found')
  const headers = [...tableMatch[0].matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1].trim())
  assert.deepStrictEqual(
    headers,
    ['Name', 'Tier', 'Description', 'Presence', 'Last used'],
    'keys table column order must match the LangSmith resource schema (rec 30)'
  )
})

test('Sample-trace fixture covers every family the empty state promises', () => {
  const fixturePath = path.resolve(__dirname, '..', 'fixtures/trace-samples/sample-session.json')
  const events = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  const types = new Set(events.filter((e) => e && e.type).map((e) => e.type))
  // Turn container: needs step/start + assistant/message + turn/end.
  assert.ok(types.has('step/start'))
  assert.ok(types.has('assistant/message'))
  assert.ok(types.has('turn/end'))
  // Partial tool-row: tool/call + tool/result (2.3 stream).
  assert.ok(types.has('tool/call'))
  assert.ok(types.has('tool/result'))
  // Compact card family: compact/start + compact/summary + compact/end.
  assert.ok(types.has('compact/start'))
  assert.ok(types.has('compact/summary'))
  assert.ok(types.has('compact/end'))
  // Subagent inline: the 2.6 notification carries a subagent.finished
  // notification-shaped event (type "_notification").
  const subagentFinishes = events.filter(
    (e) => e && e.type === '_notification' && e.method === 'subagent.finished'
  )
  assert.ok(subagentFinishes.length >= 1, 'subagent.finished notification present')
})
