// applyScratchOverlay must be atomic and undoable (drift D12): the live
// overlay is user project state — a crash mid-apply must never leave a
// truncated file, and every apply must leave a .bak for manual rollback.
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { applyScratchOverlay } = require('../src/main/playground.js')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apply-'))
}

test('applyScratchOverlay writes atomically and snapshots the previous overlay', () => {
  const dir = tmpdir()
  const scratch = path.join(dir, 'scratch.yml')
  const live = path.join(dir, 'live.yml')
  fs.writeFileSync(scratch, '  path: "/scratch/base"\nplugins: [a]\n')
  fs.writeFileSync(live, 'plugins: [old]\n')
  const res = applyScratchOverlay(
    { scratchOverlayPath: scratch, originalBaseRef: '/orig/base' },
    live,
  )
  assert.strictEqual(res.ok, true)
  // Path line restored to the original base ref, not the scratch one.
  assert.match(fs.readFileSync(live, 'utf8'), /\/orig\/base/)
  // Previous live overlay preserved verbatim in the .bak snapshot.
  assert.strictEqual(res.backupPath, `${live}.bak`)
  assert.strictEqual(fs.readFileSync(res.backupPath, 'utf8'), 'plugins: [old]\n')
  // No temp debris left behind.
  const debris = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.deepStrictEqual(debris, [])
})

test('applyScratchOverlay with no pre-existing live overlay reports null backup', () => {
  const dir = tmpdir()
  const scratch = path.join(dir, 'scratch.yml')
  const live = path.join(dir, 'sub', 'live.yml')
  fs.writeFileSync(scratch, '  path: "/scratch/base"\n')
  const res = applyScratchOverlay(
    { scratchOverlayPath: scratch, originalBaseRef: '/orig/base' },
    live,
  )
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.backupPath, null)
  assert.ok(fs.existsSync(live))
})
