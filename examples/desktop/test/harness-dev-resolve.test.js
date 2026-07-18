// HARNESS_DEV candidate-ordering lock (2026-07-18, P0-1 in-repo detection).
//
// Fresh clones of the official repo don't have a sibling
// `deepseek-harness-dev/`, so the previous sibling-only resolver handed
// the runtime spawner a phantom path and preflight refused to boot.
// `resolveHarnessDev` now tries three candidates in order:
//
//   1. env `DSH_DEV_ROOT` — explicit override.
//   2. walk-up in-repo — first ancestor of the startDir that contains
//      `packages/examples/jsonrpc-demo/src/bin.ts`. This is the shape a
//      user hits when this shell ships inside deepseek-harness at
//      `examples/desktop/`.
//   3. sibling `deepseek-harness-dev/` (with `.worktrees/integration`
//      preference) — the original dev-workflow layout.
//
// These tests drive the resolver against a mock filesystem so the
// ordering is locked without needing either real layout on disk.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { resolveHarnessDev } = require('../src/main/profiles.js')

function mockFsWith(existing) {
  // A minimal `accessSync` shim that throws unless the queried path
  // matches one of the entries in `existing` (a Set of absolute paths).
  const set = existing instanceof Set ? existing : new Set(existing)
  return {
    accessSync(p) {
      if (!set.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, access '${p}'`)
        err.code = 'ENOENT'
        throw err
      }
    },
  }
}

test('candidate 1 wins: DSH_DEV_ROOT env overrides everything else', () => {
  // Even if the in-repo marker exists AND a sibling clone exists, the
  // env override takes precedence and gets resolved to an absolute path.
  const start = '/repo/examples/desktop/src/main'
  const fs = mockFsWith([
    // in-repo marker (would win candidate 2 otherwise)
    '/repo/packages/examples/jsonrpc-demo/src/bin.ts',
    // integration daemon dir (would win candidate 3 otherwise)
    '/other/deepseek-harness-dev/.worktrees/integration/packages/examples/daemon-demo',
  ])
  const got = resolveHarnessDev(start, { DSH_DEV_ROOT: '/custom/checkout' }, fs)
  assert.equal(got, path.resolve('/custom/checkout'))
})

test('candidate 2 wins: in-repo marker on the ancestor chain when no env', () => {
  // Startdir is examples/desktop/src/main; repo root two levels up
  // holds the jsonrpc-demo marker. The walk-up should return that root
  // before falling through to the sibling candidate.
  const start = '/repo/examples/desktop/src/main'
  const marker = '/repo/packages/examples/jsonrpc-demo/src/bin.ts'
  const fs = mockFsWith([marker])
  const got = resolveHarnessDev(start, {}, fs)
  assert.equal(got, '/repo')
})

test('candidate 2 walks up at most 6 levels, then gives up', () => {
  // Bury the marker 7 levels up — beyond the cap. Resolver must NOT
  // find it; it should fall through to candidate 3 (sibling) which
  // itself doesn't exist here, so the resolver returns the base sibling
  // path unchanged (no exception).
  const start = '/a/b/c/d/e/f/g/src/main'
  const marker = '/a/packages/examples/jsonrpc-demo/src/bin.ts' // 8 levels up from start
  const fs = mockFsWith([marker])
  const got = resolveHarnessDev(start, {}, fs)
  // Sibling fallback: __dirname's ../../../deepseek-harness-dev
  const expectedBase = path.resolve(start, '..', '..', '..', 'deepseek-harness-dev')
  assert.equal(got, expectedBase, 'walk-up must not reach past the 6-level cap; falls through to sibling')
})

test('candidate 3 wins: sibling deepseek-harness-dev is the fallback when no marker on chain', () => {
  // No in-repo marker anywhere, and no integration daemon-demo either
  // — the resolver returns the base sibling path.
  const start = '/ws/dsh-desktop-demo/src/main'
  const fs = mockFsWith([]) // nothing exists
  const got = resolveHarnessDev(start, {}, fs)
  assert.equal(got, path.resolve('/ws/dsh-desktop-demo/src/main', '..', '..', '..', 'deepseek-harness-dev'))
  assert.equal(got, '/ws/deepseek-harness-dev', 'sibling one directory up from the demo root')
})

test('candidate 3 prefers .worktrees/integration when daemon-demo is materialized there', () => {
  // Sibling `deepseek-harness-dev` exists with the integration worktree
  // materialized (Phase-2 daemon lives there until it lands on master),
  // so the resolver returns the integration path over the base clone.
  const start = '/ws/dsh-desktop-demo/src/main'
  const base = '/ws/deepseek-harness-dev'
  const integration = path.join(base, '.worktrees', 'integration')
  const daemonDir = path.join(integration, 'packages', 'examples', 'daemon-demo')
  const fs = mockFsWith([daemonDir])
  const got = resolveHarnessDev(start, {}, fs)
  assert.equal(got, integration, 'integration worktree preferred over base clone when daemon-demo is there')
})

test('official-repo shape end-to-end: startDir inside examples/desktop resolves to repo root', () => {
  // The failure the P0-1 fix was written for: user clones
  // deepseek-harness fresh, launches from examples/desktop. Resolver
  // must NOT hand back `deepseek-harness/examples/deepseek-harness-dev`
  // (which doesn't exist). It must return the repo root itself.
  const start = '/Users/downloader/deepseek-harness/examples/desktop/src/main'
  const marker = '/Users/downloader/deepseek-harness/packages/examples/jsonrpc-demo/src/bin.ts'
  const fs = mockFsWith([marker])
  const got = resolveHarnessDev(start, {}, fs)
  assert.equal(got, '/Users/downloader/deepseek-harness')
})
