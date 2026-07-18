// Unit tests for src/main/hub-assets.js — the file-tier asset store and
// script runner. Everything runs under `node --test` against a temp dir.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const A = require('../src/main/hub-assets.js')

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-test-'))
}

test('ensureRootDirs creates one folder per kind', () => {
  const rt = mktemp()
  A.ensureRootDirs(rt)
  for (const kind of Object.keys(A.KIND_EXT)) {
    const dir = path.join(rt, 'hub', kind + 's')
    assert.ok(fs.statSync(dir).isDirectory(), `${kind} dir should exist`)
  }
})

test('writeAsset + readAsset round-trip a prompt file', () => {
  const rt = mktemp()
  A.writeAsset(rt, 'prompt', 'greeter', 'You are a helpful greeter.')
  const back = A.readAsset(rt, 'prompt', 'greeter')
  assert.equal(back, 'You are a helpful greeter.')
})

test('writeAsset backs up the prior file to .<timestamp>.bak', async () => {
  const rt = mktemp()
  A.writeAsset(rt, 'prompt', 'greeter', 'v1 body')
  // Ensure the mtime timestamp differs so the .bak name is unique.
  await new Promise((r) => setTimeout(r, 5))
  const res = A.writeAsset(rt, 'prompt', 'greeter', 'v2 body')
  assert.equal(res.versions.length >= 2, true, 'should have current + at least one .bak')
  const baks = res.versions.filter((v) => v.path.endsWith('.bak'))
  assert.equal(baks.length >= 1, true)
  const backupBody = A.readVersion(rt, 'prompt', baks[0].path)
  assert.equal(backupBody, 'v1 body')
})

test('isSafeName rejects escapes + accepts hyphens/underscores', () => {
  assert.equal(A.isSafeName('dedup_exact'), true)
  assert.equal(A.isSafeName('a-b.c'), true)
  assert.equal(A.isSafeName('..'), false)
  assert.equal(A.isSafeName('../etc/passwd'), false)
  assert.equal(A.isSafeName(''), false)
  assert.equal(A.isSafeName('a/b'), false)
})

test('listKind returns dataset rows with row counts', () => {
  const rt = mktemp()
  A.writeAsset(rt, 'dataset', 'seed', '{"a":1}\n{"a":2}\n{"a":3}\n')
  const rows = A.listKind(rt, 'dataset')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'seed')
  assert.equal(rows[0].rowCount, 3)
})

test('listKind returns script rows with detected language', () => {
  const rt = mktemp()
  A.writeAsset(rt, 'script', 'dedup.py', 'print("hi")')
  A.writeAsset(rt, 'script', 'wrap.sh', 'echo hi')
  const rows = A.listKind(rt, 'script')
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.equal(byName['dedup'].lang, 'python')
  assert.equal(byName['wrap'].lang, 'shell')
})

test('listAll returns rows across kinds', () => {
  const rt = mktemp()
  A.writeAsset(rt, 'prompt', 'a', 'x')
  A.writeAsset(rt, 'dataset', 'b', '{}\n')
  A.writeAsset(rt, 'script', 'c.py', 'x')
  const all = A.listAll(rt)
  const kinds = new Set(all.map((r) => r.kind))
  assert.ok(kinds.has('prompt'))
  assert.ok(kinds.has('dataset'))
  assert.ok(kinds.has('script'))
})

test('parseStdoutSummary picks the last JSON object with written/dropped', () => {
  const out = 'processing…\n{"progress":0.5}\n{"written":10,"dropped":2,"notes":"ok"}\n'
  const s = A.parseStdoutSummary(out)
  assert.equal(s.written, 10)
  assert.equal(s.dropped, 2)
  assert.equal(s.notes, 'ok')
})

test('narrowEnv drops non-allowlisted keys but keeps PATH + DEEPSEEK_API_KEY', () => {
  const env = A.narrowEnv({
    PATH: '/usr/bin', DEEPSEEK_API_KEY: 'sk-abc', HOME: '/home/x',
    SECRET_TOKEN: 'nope', RANDOM_KEY: 'nope',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-abc')
  assert.equal(env.HOME, '/home/x')
  assert.equal(env.DSH_DEMO_HUB, '1')
  assert.equal('SECRET_TOKEN' in env, false)
  assert.equal('RANDOM_KEY' in env, false)
})

test('runScript executes a bash script + streams stdout + writes .last.json', async () => {
  const rt = mktemp()
  // A tiny shell script that copies input JSONL to output JSONL and emits
  // a summary line. Uses `bash` so this test runs on any macOS/linux CI.
  const body = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'input="$1"',
    'output="$2"',
    'cp "$input" "$output"',
    'n=$(grep -c "^{" "$input" || true)',
    'echo "processed $n rows"',
    'echo "{\\"written\\": $n, \\"dropped\\": 0, \\"notes\\": \\"copy through\\"}"',
  ].join('\n') + '\n'
  A.writeAsset(rt, 'script', 'passthru.sh', body)
  A.writeAsset(rt, 'dataset', 'seed', '{"a":1}\n{"a":2}\n{"a":3}\n')

  const events = []
  const scriptPath = path.join(rt, 'hub', 'scripts', 'passthru.sh')
  await new Promise((resolve, reject) => {
    A.runScript(rt, {
      scriptPath, lang: 'shell',
      input: { kind: 'dataset', name: 'seed' },
      on: (ev) => {
        events.push(ev)
        if (ev.stream === 'exit') resolve(ev)
      },
    })
    setTimeout(() => reject(new Error('script timed out')), 5000)
  })
  const exit = events.find((e) => e.stream === 'exit')
  assert.equal(exit.code, 0, 'script should exit 0')
  assert.equal(exit.summary.written, 3)
  assert.equal(exit.summary.dropped, 0)
  assert.equal(exit.summary.notes, 'copy through')
  assert.equal(exit.outputRows, 3)
  // A .last.json sibling must be written so `listKind` shows lastStatus.
  const meta = JSON.parse(fs.readFileSync(scriptPath + '.last.json', 'utf8'))
  assert.equal(meta.status, 'ok')
  assert.equal(meta.summary.written, 3)
})

test('runScript falls back to derived summary when stdout is silent', async () => {
  const rt = mktemp()
  const body = [
    '#!/usr/bin/env bash',
    'cp "$1" "$2"',
    'true',            // no stdout summary
  ].join('\n') + '\n'
  A.writeAsset(rt, 'script', 'silent.sh', body)
  A.writeAsset(rt, 'dataset', 'seed', '{"a":1}\n{"a":2}\n')
  const scriptPath = path.join(rt, 'hub', 'scripts', 'silent.sh')
  const exit = await new Promise((resolve, reject) => {
    A.runScript(rt, {
      scriptPath, lang: 'shell',
      input: { kind: 'dataset', name: 'seed' },
      on: (ev) => { if (ev.stream === 'exit') resolve(ev) },
    })
    setTimeout(() => reject(new Error('script timed out')), 5000)
  })
  assert.equal(exit.summary.source, 'derived')
  assert.equal(exit.summary.notes, 'no summary emitted')
  assert.equal(exit.summary.written, 2)
})

test('seedSamples copies files idempotently', () => {
  const rt = mktemp()
  const src = mktemp()
  // Build a mini sample bundle
  fs.mkdirSync(path.join(src, 'prompts'), { recursive: true })
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(src, 'prompts', 'greeter.md'), 'hi')
  fs.writeFileSync(path.join(src, 'scripts', 'dedup.py'), 'print("x")')

  const first = A.seedSamples(rt, src)
  assert.equal(first.copied, 2)
  const again = A.seedSamples(rt, src)
  assert.equal(again.copied, 0, 'idempotent seed should not overwrite')
})

test('readVersion rejects a path outside the kind dir', () => {
  const rt = mktemp()
  A.writeAsset(rt, 'prompt', 'greeter', 'x')
  assert.throws(() => A.readVersion(rt, 'prompt', '/etc/passwd'),
    /outside kind dir/)
})
