// Yarn constraints: mechanize the package rules from AGENTS.md.
// Run with `yarn constraints`; CI fails on violations.
//
// 1. Every package is private (nothing publishes from this repo yet).
// 2. Harness packages (@deepseek-ai/dsh-*) declare `cordis` as BOTH a
//    peerDependency and a devDependency (upstream Cordis convention).
// 3. Harness packages are versioned 0.0.1 (bumped together, later via tooling).
// 4. Vendored packages keep their upstream versions — constraints don't touch
//    them beyond privacy.
// 5. All packages are ESM (`"type": "module"`) — except vendored packages
//    whose upstream isn't (schemastery ships dual cjs/mjs without type).

/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types')

const VENDORED = new Set([
  'cordis', 'cosmokit', 'schemastery',
  '@cordisjs/plugin-loader', '@cordisjs/plugin-include', '@cordisjs/plugin-group',
  '@cordisjs/plugin-timer', '@cordisjs/plugin-hmr', '@cordisjs/plugin-logger-console',
])

module.exports = defineConfig({
  async constraints({ Yarn }) {
    for (const workspace of Yarn.workspaces()) {
      const name = workspace.manifest.name

      // (1) everything stays private
      workspace.set('private', true)

      if (name?.startsWith('@deepseek-ai/dsh-') && name !== '@deepseek-ai/dsh-root') {
        // (2) cordis as peer + dev
        const peer = Yarn.dependency({ workspace, ident: 'cordis', type: 'peerDependencies' })
        const dev = Yarn.dependency({ workspace, ident: 'cordis', type: 'devDependencies' })
        if (!peer) workspace.error(`${name}: cordis must be a peerDependency`)
        if (!dev) workspace.error(`${name}: cordis must also be a devDependency`)
        if (peer && dev && peer.range !== dev.range) {
          workspace.error(`${name}: cordis peer (${peer.range}) and dev (${dev.range}) ranges must match`)
        }

        // (3) uniform version
        workspace.set('version', '0.0.1')

        // (5) ESM
        workspace.set('type', 'module')
      }

      if (name && VENDORED.has(name)) {
        // (4) vendored: privacy only; versions/fields follow upstream
        continue
      }
    }
  },
})
