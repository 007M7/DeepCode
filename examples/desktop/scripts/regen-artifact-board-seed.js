#!/usr/bin/env node
// Regenerates src/renderer/artifact-board-seed.js from
// docs/artifact-board-fixture.json. Renderer runs at file:// so we inline
// the fixture instead of fetch().
//
// Usage: node scripts/regen-artifact-board-seed.js

'use strict'
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const src = path.join(root, 'docs', 'artifact-board-fixture.json')
const dst = path.join(root, 'src', 'renderer', 'artifact-board-seed.js')

const j = JSON.parse(fs.readFileSync(src, 'utf8'))
const body = "// Auto-inlined artifact-board fixture. Renderer runs at file:// so we\n" +
  "// inline docs/artifact-board-fixture.json here instead of relying on fetch().\n" +
  "// To refresh: node scripts/regen-artifact-board-seed.js\n" +
  "\n" +
  "'use strict'\n" +
  ";(function () {\n" +
  "  if (typeof window === 'undefined') return\n" +
  "  window.__dshArtifactBoardSeed = " + JSON.stringify(j, null, 2) + ";\n" +
  "})()\n"
fs.writeFileSync(dst, body)
console.log('wrote', dst, '(' + body.length + ' bytes)')
