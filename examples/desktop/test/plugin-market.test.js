// Unit tests for src/main/plugin-market.js — the pure index parser +
// install-state computer. No Electron, no IPC.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const M = require('../src/main/plugin-market.js')

const SAMPLE_INDEX = {
  version: 1,
  source: 'local',
  updatedAt: '2026-07-16',
  entries: [
    {
      id: 'tool-web',
      package: '@deepseek-ai/dsh-tool-web',
      title: 'Web tools',
      description: 'Model-facing web_search / web_fetch.',
      author: 'DeepSeek',
      permissions: ['net'],
      tags: ['research'],
      entry: { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
    },
    {
      id: 'time-context',
      package: '@deepseek-ai/dsh-time-context',
      title: 'Time context',
      description: 'Adds current time to system prompt.',
      author: 'DeepSeek',
      // no entry — defaults to { id, name: package }
      tags: ['context'],
    },
    {
      id: 'tool-todo',
      package: '@deepseek-ai/dsh-tool-todo',
      title: 'Todo writer',
      description: 'Session-owned todo list.',
      author: 'DeepSeek',
      permissions: [],
      tags: ['planning'],
    },
  ],
}

test('parseIndex: normalizes rows and defaults entry from id + package', () => {
  const parsed = M.parseIndex(SAMPLE_INDEX)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.source, 'local')
  assert.equal(parsed.entries.length, 3)
  const web = parsed.entries.find((r) => r.id === 'tool-web')
  assert.deepEqual(web.entry, { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' })
  assert.deepEqual(web.permissions, ['net'])
  const time = parsed.entries.find((r) => r.id === 'time-context')
  assert.deepEqual(time.entry, { id: 'time-context', name: '@deepseek-ai/dsh-time-context' })
  assert.deepEqual(time.permissions, [])
})

test('parseIndex: accepts a JSON string as input', () => {
  const parsed = M.parseIndex(JSON.stringify(SAMPLE_INDEX))
  assert.equal(parsed.entries.length, 3)
})

test('parseIndex: rejects malformed roots', () => {
  assert.throws(() => M.parseIndex('null'), /root is not an object/)
  assert.throws(() => M.parseIndex({ version: 2, entries: [] }), /unsupported version/)
  assert.throws(() => M.parseIndex({ version: 1, entries: 'nope' }), /entries.*array/)
})

test('parseIndex: skips malformed rows but keeps the rest', () => {
  const parsed = M.parseIndex({
    version: 1,
    entries: [
      SAMPLE_INDEX.entries[0],
      { id: 'oops' }, // missing package/title/description
      null,
      SAMPLE_INDEX.entries[1],
    ],
  })
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.skipped.length, 2)
  assert.match(parsed.skipped[0].reason, /missing field/)
  assert.match(parsed.skipped[1].reason, /not an object/)
})

test('computeMarketState: available when not in base or overlay', () => {
  const index = M.parseIndex(SAMPLE_INDEX)
  const rows = M.computeMarketState(index, [], [])
  assert.equal(rows.length, 3)
  for (const r of rows) {
    assert.equal(r.status, 'available')
    assert.equal(r.installSource, null)
  }
})

test('computeMarketState: installed when the entry ships in the base leaf', () => {
  const index = M.parseIndex(SAMPLE_INDEX)
  const base = [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }]
  const rows = M.computeMarketState(index, base, [])
  const web = rows.find((r) => r.row.id === 'tool-web')
  assert.equal(web.status, 'installed')
  assert.equal(web.installSource, 'base')
})

test('computeMarketState: installed via user overlay patch', () => {
  const index = M.parseIndex(SAMPLE_INDEX)
  const patches = [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', insert: 'append' }]
  const rows = M.computeMarketState(index, [], patches)
  const todo = rows.find((r) => r.row.id === 'tool-todo')
  assert.equal(todo.status, 'installed')
  assert.equal(todo.installSource, 'user')
})

test('computeMarketState: disabled when overlay disables a base entry', () => {
  const index = M.parseIndex(SAMPLE_INDEX)
  const base = [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }]
  const patches = [{ id: 'tool-web', disabled: true }]
  const rows = M.computeMarketState(index, base, patches)
  const web = rows.find((r) => r.row.id === 'tool-web')
  assert.equal(web.status, 'disabled')
  assert.equal(web.installSource, 'base')
})

test('computeMarketState: bare disabled patch without matching base is not "installed"', () => {
  // A patch with `disabled: true` and no `name` doesn't introduce a new
  // entry — it's a dangling toggle. Treat as "available" since the entry
  // isn't actually in the folded list.
  const index = M.parseIndex(SAMPLE_INDEX)
  const patches = [{ id: 'tool-todo', disabled: true }]
  const rows = M.computeMarketState(index, [], patches)
  const todo = rows.find((r) => r.row.id === 'tool-todo')
  assert.equal(todo.status, 'available')
})

test('groupByTag: groups rows by tag with an "other" bucket for empty tags', () => {
  const index = M.parseIndex({
    version: 1,
    entries: [
      { id: 'a', package: '@x/a', title: 'A', description: 'a', tags: ['coding', 'essentials'] },
      { id: 'b', package: '@x/b', title: 'B', description: 'b', tags: ['coding'] },
      { id: 'c', package: '@x/c', title: 'C', description: 'c' },
    ],
  })
  const buckets = M.groupByTag(index.entries)
  assert.equal(buckets.get('coding').length, 2)
  assert.equal(buckets.get('essentials').length, 1)
  assert.equal(buckets.get('other').length, 1)
})

test('bundled config/plugin-index.json parses cleanly', () => {
  const p = path.join(__dirname, '..', 'config', 'plugin-index.json')
  const text = fs.readFileSync(p, 'utf8')
  const parsed = M.parseIndex(text)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.source, 'local')
  assert.equal(parsed.skipped.length, 0)
  // Sanity: at least a handful of curated rows, each with a valid entry.
  assert.ok(parsed.entries.length >= 8, `expected ≥8 entries, got ${parsed.entries.length}`)
  for (const r of parsed.entries) {
    assert.ok(r.entry && r.entry.id && r.entry.name, `row ${r.id} missing entry`)
    assert.match(r.entry.name, /^@deepseek-ai\//,
      `row ${r.id} entry.name should point at a workspace package`)
  }
})
