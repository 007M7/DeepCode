// Unit tests for src/main/plugin-validation.js — static overlay validation.
// Uses in-memory fixtures so no dev-clone is required.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const V = require('../src/main/plugin-validation.js')

// A small stand-in for `deepseek-harness-dev/packages/`. We create one group
// with two publishable packages so the workspace scanner has real work.
function makeFakePackagesRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-validation-'))
  const bash = path.join(root, 'bash', 'bash-local')
  const fsGroup = path.join(root, 'fs', 'fs-local')
  const stray = path.join(root, 'stray')
  fs.mkdirSync(bash, { recursive: true })
  fs.mkdirSync(fsGroup, { recursive: true })
  fs.mkdirSync(stray, { recursive: true })
  fs.writeFileSync(path.join(bash, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-bash-local' }))
  fs.writeFileSync(path.join(fsGroup, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-fs-local' }))
  // stray/ has no package.json — the scanner must silently skip it.
  return root
}

test('scanWorkspacePackages picks up @deepseek-ai/dsh-* names, skips dirs without package.json', () => {
  const root = makeFakePackagesRoot()
  try {
    const names = V.scanWorkspacePackages(root)
    assert.ok(names.has('@deepseek-ai/dsh-bash-local'))
    assert.ok(names.has('@deepseek-ai/dsh-fs-local'))
    assert.equal(names.size, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scanWorkspacePackages: missing dir returns empty set (no throw)', () => {
  const names = V.scanWorkspacePackages('/definitely/does/not/exist')
  assert.equal(names.size, 0)
})

test('classifyName recognises packages, relative paths, and absolute paths', () => {
  assert.equal(V.classifyName('@deepseek-ai/dsh-bash-local'), 'package')
  assert.equal(V.classifyName('cordis'), 'package')
  assert.equal(V.classifyName('../../foo/bar.ts'), 'relative-path')
  assert.equal(V.classifyName('./inline.ts'), 'relative-path')
  assert.equal(V.classifyName('/etc/passwd'), 'absolute-path')
  assert.equal(V.classifyName(''), 'unknown')
})

test('packageResolves: known package passes', () => {
  const known = new Set(['@deepseek-ai/dsh-bash-local'])
  const reason = V.packageResolves(
    { id: 'bash', name: '@deepseek-ai/dsh-bash-local' },
    { knownPackages: known, leafDir: '/tmp' },
  )
  assert.equal(reason, null)
})

test('packageResolves: unknown package fails with a helpful message', () => {
  const known = new Set(['@deepseek-ai/dsh-fs-local'])
  const reason = V.packageResolves(
    { id: 'bash', name: '@deepseek-ai/dsh-bash-local' },
    { knownPackages: known, leafDir: '/tmp' },
  )
  assert.match(reason, /package not found/)
})

test('packageResolves: relative path resolves against leafDir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-validation-'))
  try {
    const target = path.join(home, 'nested', 'plugin.ts')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '// hi')
    const reason = V.packageResolves(
      { id: 'x', name: './nested/plugin.ts' },
      { knownPackages: new Set(), leafDir: home },
    )
    assert.equal(reason, null)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('packageResolves: missing file surfaces the path', () => {
  const reason = V.packageResolves(
    { id: 'x', name: './does-not-exist.ts' },
    { knownPackages: new Set(), leafDir: '/tmp' },
  )
  assert.match(reason, /file does not exist/)
})

test('editDistance handles identical, empty, and typical inputs', () => {
  assert.equal(V.editDistance('abc', 'abc'), 0)
  assert.equal(V.editDistance('', 'abc'), 3)
  assert.equal(V.editDistance('kitten', 'sitting'), 3)
  assert.equal(V.editDistance('bash', 'bosh'), 1)
})

test('validate: clean base + no patches → no diagnostics', () => {
  const diags = V.validate({
    baseEntries: [
      { id: 'bash', name: '@deepseek-ai/dsh-bash-local', line: 1 },
      { id: 'fs', name: '@deepseek-ai/dsh-fs-local', line: 3 },
    ],
    overlay: { base: '', patches: [] },
    knownPackages: new Set(['@deepseek-ai/dsh-bash-local', '@deepseek-ai/dsh-fs-local']),
    leafDir: '/tmp',
  })
  assert.equal(diags.length, 0)
})

test('validate: unknown package on a base entry → error diagnostic with line', () => {
  const diags = V.validate({
    baseEntries: [{ id: 'bash', name: '@deepseek-ai/does-not-exist', line: 7 }],
    overlay: { base: '', patches: [] },
    knownPackages: new Set(),
    leafDir: '/tmp',
  })
  const err = diags.find((d) => d.severity === 'error' && d.id === 'bash')
  assert.ok(err)
  assert.equal(err.line, 7)
  assert.match(err.message, /package not found/)
})

test('validate: patch targets an id absent from base → error diagnostic', () => {
  const diags = V.validate({
    baseEntries: [{ id: 'bash', name: '@deepseek-ai/dsh-bash-local' }],
    overlay: { base: '', patches: [{ id: 'ghost', disabled: true, line: 12 }] },
    knownPackages: new Set(['@deepseek-ai/dsh-bash-local']),
    leafDir: '/tmp',
  })
  const err = diags.find((d) => d.scope === 'patch' && d.id === 'ghost')
  assert.ok(err)
  assert.equal(err.line, 12)
  assert.match(err.message, /not in the base leaf/)
})

test('validate: new-entry patch with an unknown package → error diagnostic', () => {
  const diags = V.validate({
    baseEntries: [{ id: 'bash', name: '@deepseek-ai/dsh-bash-local' }],
    overlay: { base: '', patches: [{ id: 'custom', name: '@nope/plugin', line: 20 }] },
    knownPackages: new Set(['@deepseek-ai/dsh-bash-local']),
    leafDir: '/tmp',
  })
  const err = diags.find((d) => d.id === 'custom')
  assert.ok(err)
  assert.match(err.message, /package not found/)
})

test('validate: near-duplicate active ids trigger a warn (not error)', () => {
  const diags = V.validate({
    baseEntries: [
      { id: 'bash-local', name: '@deepseek-ai/dsh-bash-local' },
      { id: 'bash-locel', name: '@deepseek-ai/dsh-bash-local' }, // typo
    ],
    overlay: { base: '', patches: [] },
    knownPackages: new Set(['@deepseek-ai/dsh-bash-local']),
    leafDir: '/tmp',
  })
  const near = diags.find((d) => d.severity === 'warn' && /near-duplicate/.test(d.message))
  assert.ok(near)
})

test('validate: disabled entries are excluded from near-duplicate check', () => {
  const diags = V.validate({
    baseEntries: [
      { id: 'bash-local', name: '@deepseek-ai/dsh-bash-local' },
      { id: 'bash-locel', name: '@deepseek-ai/dsh-bash-local' },
    ],
    overlay: { base: '', patches: [{ id: 'bash-locel', disabled: true }] },
    knownPackages: new Set(['@deepseek-ai/dsh-bash-local']),
    leafDir: '/tmp',
  })
  const near = diags.find((d) => /near-duplicate/.test(d.message))
  assert.equal(near, undefined)
})

test('validate: tool-count warning at configurable threshold', () => {
  const many = []
  for (let i = 0; i < 5; i++) many.push({ id: `p${i}`, name: '@deepseek-ai/dsh-bash-local' })
  const diags = V.validate({
    baseEntries: many,
    overlay: { base: '', patches: [] },
    knownPackages: new Set(['@deepseek-ai/dsh-bash-local']),
    leafDir: '/tmp',
    toolCountWarnAt: 3,
  })
  const w = diags.find((d) => /enabled entries/.test(d.message))
  assert.ok(w)
  assert.equal(w.severity, 'warn')
})

test('validate: duplicate id in base → error', () => {
  const diags = V.validate({
    baseEntries: [
      { id: 'bash', name: '@deepseek-ai/dsh-bash-local', line: 1 },
      { id: 'bash', name: '@deepseek-ai/dsh-bash-local', line: 5 },
    ],
    overlay: { base: '', patches: [] },
    knownPackages: new Set(['@deepseek-ai/dsh-bash-local']),
    leafDir: '/tmp',
  })
  const dup = diags.find((d) => /duplicate id/.test(d.message))
  assert.ok(dup)
  assert.equal(dup.severity, 'error')
})
