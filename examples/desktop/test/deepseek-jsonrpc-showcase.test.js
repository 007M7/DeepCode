// deepseek-jsonrpc.yml must ship the showcase defaults for a first-run user.
//
// Two visualizations are our headline differentiators — reasoning fold and
// diff card. Both depend on config decisions in the default profile that a
// future edit could silently drop:
//
//   - `thinking: enabled` on the llm-deepseek entry. The provider default is
//     already "enabled" today, but pinning it means a future flip in the
//     upstream default won't silently drop the reasoning-delta stream on
//     this profile.
//   - The full model-facing filesystem stack: fs-local (backend) + fs-policy
//     (read-before-write contract) + tool-fs (registers fs.read/edit/write as
//     model-facing tools). Without tool-fs specifically, the model has no fs
//     tool exposed — it will reply "no fs tool available" — and the diff card
//     (family=fs, the sole source per tool-cards.js) is unreachable on the
//     default profile.
//
// These are lockable as static text (no YAML parser dep) because both files
// stick to the flat `- id: … name: … config: …` shape asserted elsewhere in
// deepseek-config-workspace-context.test.js.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CFG = path.join(__dirname, '..', 'config')

function readConfig(name) {
  return fs.readFileSync(path.join(CFG, name), 'utf8')
}

// Slice out the block of a single top-level entry keyed on `- id: <id>`.
// Bounded by the next `- id:` line (or EOF). Matches the same convention
// used by deepseek-config-workspace-context.test.js so an entry's config
// block can be asserted independently of neighbours.
function entryWindow(src, id) {
  const startIdx = src.indexOf(`- id: ${id}`)
  if (startIdx === -1) return null
  const rest = src.slice(startIdx + 1)
  const nextIdx = rest.indexOf('\n- id:')
  const end = nextIdx === -1 ? src.length : startIdx + 1 + nextIdx
  return src.slice(startIdx, end)
}

test('deepseek-jsonrpc.yml pins thinking: enabled on llm-deepseek', () => {
  const src = readConfig('deepseek-jsonrpc.yml')
  const window = entryWindow(src, 'llm-deepseek')
  assert.ok(window, 'default profile must have an llm-deepseek entry')
  assert.match(
    window,
    /thinking\s*:\s*enabled\b/,
    'default profile must pin thinking: enabled — dropping this can silently kill the reasoning fold if the upstream default flips',
  )
})

test('deepseek-jsonrpc.yml ships the full fs stack for the diff-card demo path', () => {
  const src = readConfig('deepseek-jsonrpc.yml')
  // The diff card is unreachable unless the model-facing fs tool is
  // registered. That requires all three plugins:
  //   - dsh-fs-local: backend
  //   - dsh-fs-policy: read-before-write contract
  //   - dsh-tool-fs: the model-facing fs.read/edit/write tools themselves
  // We assert on the fully-qualified plugin names so an id-column rename
  // doesn't accidentally hide the drop.
  assert.match(
    src,
    /@deepseek-ai\/dsh-fs-local\b/,
    'default profile must include @deepseek-ai/dsh-fs-local — the fs backend',
  )
  assert.match(
    src,
    /@deepseek-ai\/dsh-fs-policy\b/,
    'default profile must include @deepseek-ai/dsh-fs-policy — read-before-write contract that tool-fs relies on',
  )
  assert.match(
    src,
    /@deepseek-ai\/dsh-tool-fs\b/,
    'default profile must include @deepseek-ai/dsh-tool-fs — without it the model has no fs tool and the diff card never renders',
  )
})

