#!/usr/bin/env node
// Regenerates src/renderer/rubric-fusion-seed.js from
// docs/rubric-fusion-fixture.json. Renderer runs at file:// so we inline
// the fixture instead of fetch().
//
// Usage: node scripts/regen-rubric-fusion-seed.js

'use strict'
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const src = path.join(root, 'docs', 'rubric-fusion-fixture.json')
const dst = path.join(root, 'src', 'renderer', 'rubric-fusion-seed.js')

const j = JSON.parse(fs.readFileSync(src, 'utf8'))
const body = "// Auto-inlined fusion fixture. Renderer runs at file:// so we inline\n" +
  "// docs/rubric-fusion-fixture.json here instead of relying on fetch().\n" +
  "// To refresh: node scripts/regen-rubric-fusion-seed.js\n" +
  "\n" +
  "'use strict'\n" +
  ";(function () {\n" +
  "  if (typeof window === 'undefined') return\n" +
  "  window.__dshRubricFusionSeed = " + JSON.stringify(j, null, 2) + ";\n" +
  "})()\n"
fs.writeFileSync(dst, body)
console.log('wrote', dst, '(' + body.length + ' bytes)')
