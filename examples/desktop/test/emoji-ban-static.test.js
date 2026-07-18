// Static gate for the emoji ban (user directive 2026-07-17; density-spec §5:
// "no emoji anywhere — typographic ✓ ✗ ↑ ↓ · allowed"). Pictographic emoji
// render as COLOR glyphs and survived one dedicated sweep batch (t159) plus
// four drift-review cycles before drift D43 caught the ⏳ family — reviewer
// eyes are provably not enough, so this locks the ban at the test layer.
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// Pictographic / symbol blocks that render as color emoji in Chromium.
// Deliberately EXCLUDES the typographic carve-outs the spec allows
// (✓ U+2713, ✗ U+2717, ↑ ↓ arrows, · ⋯ ∘ ▸ ▹ punctuation/math).
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{2712}\u{2714}\u{2716}\u{2728}-\u{274B}\u{2753}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u

const ROOTS = ['src/renderer', 'src/main', 'src/preload']

test('no pictographic emoji in shipped source (drift D43 gate)', () => {
  const offenders = []
  for (const root of ROOTS) {
    const dir = path.resolve(__dirname, '..', root)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(js|html|css)$/.test(f)) continue
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        // Comments are exempt: the ban is about rendered UI, and docs may
        // legitimately NAME a banned glyph while explaining the ban.
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) return
        const m = line.match(EMOJI_RE)
        if (m) offenders.push(`${root}/${f}:${i + 1} contains ${JSON.stringify(m[0])}`)
      })
    }
  }
  assert.deepStrictEqual(offenders, [],
    `emoji ban violated:\n${offenders.join('\n')}`)
})
