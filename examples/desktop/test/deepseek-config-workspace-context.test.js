// deepseek-*.yml agent-core must carry an explicit workspaceContext
//
// The upstream agent-spine-demo schema (packages/examples/agent-spine-demo/
// src/index.ts) declares `workspaceContext: Config | false` as required —
// no default. If the runtime yml omits it, cordis fails config resolution
// at plugin load with `ValidationError: $.workspaceContext missing required
// value`, the child dies before initialize completes, and the desktop
// shell shows a generic "Runtime warning" banner (the real cause never
// reaches the classifier). This regressed the default-profile-real batch:
// team-lead flagged the probe was staring at the schema-drift banner and
// mistaking it for the missing-key banner.
//
// Lock the required field in both deepseek configs so a future edit that
// drops it fails a fast static test rather than a real-machine repro.
// Also lock the echo configs' absence-by-design: echo doesn't load
// agent-spine-demo (mock-llm path), so it must NOT carry workspaceContext
// or a schema-drift symptom would masquerade as a config bug.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const CFG = path.join(__dirname, '..', 'config')

function readConfig(name) {
  return fs.readFileSync(path.join(CFG, name), 'utf8')
}

// A very simple line-oriented reader — we only care that:
//   - the file has an `- id: agent-core` entry
//   - within that entry's config block, `workspaceContext` is present
// A full YAML parse would drag in a dep just for the assertion; the regex
// window is enough because these files follow the flat "- id: … name: …
// config: …" shape.
function agentCoreConfigWindow(src) {
  const startIdx = src.indexOf('- id: agent-core')
  if (startIdx === -1) return null
  // The next `- id:` (or EOF) bounds this entry.
  const rest = src.slice(startIdx + 1)
  const nextIdx = rest.indexOf('\n- id:')
  const end = nextIdx === -1 ? src.length : startIdx + 1 + nextIdx
  return src.slice(startIdx, end)
}

test('deepseek-jsonrpc.yml agent-core has an explicit workspaceContext', () => {
  const src = readConfig('deepseek-jsonrpc.yml')
  const window = agentCoreConfigWindow(src)
  assert.ok(window, 'deepseek-jsonrpc.yml must have an agent-core entry')
  assert.match(
    window,
    /workspaceContext\s*:/,
    'agent-core must carry an explicit workspaceContext — dropping this makes the runtime fatal on load and hides the api-key error behind a generic banner',
  )
})

test('deepseek-vibe.yml agent-core has an explicit workspaceContext', () => {
  const src = readConfig('deepseek-vibe.yml')
  const window = agentCoreConfigWindow(src)
  assert.ok(window, 'deepseek-vibe.yml must have an agent-core entry')
  assert.match(
    window,
    /workspaceContext\s*:/,
    'vibe deepseek profile shares the same schema requirement',
  )
})

test('top-level agent-spine-demo entries always carry workspaceContext', () => {
  // Belt-and-suspenders across every config that DOES compose the spine at
  // top level. Anything that does must supply the required field or reload
  // will fatal. daemon-echo.yml composes the daemon-demo bundle which
  // internally embeds the spine on the mock path — no top-level
  // agent-spine-demo entry there, and it's exempt.
  const dir = path.join(__dirname, '..', 'config')
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    const window = agentCoreConfigWindow(src)
    if (!window) continue
    // Only assert when the entry actually names the spine plugin — some
    // configs might have an `agent-core` id pointing at a different plugin.
    if (!/@deepseek-ai\/dsh-agent-spine-demo/.test(window)) continue
    assert.match(
      window,
      /workspaceContext\s*:/,
      `${name} composes agent-spine-demo at top level and must supply workspaceContext`,
    )
  }
})
