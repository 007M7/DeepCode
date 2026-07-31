import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')

/** The declarations of one top-level rule, by selector. */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`ModelsSection.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('ModelsSection theme styles', () => {
  it('uses the shared theme tokens without light-only fallbacks', () => {
    // The section once named `--border`/`--surface`/`--text-*`/`--accent-strong`,
    // which nothing in this app defines, so it rendered the light-mode literals
    // written as their fallbacks and stayed light under the dark theme.
    expect(css).not.toMatch(/var\(--(?:surface|text-|border|accent-strong)/)
    expect(css).toContain('color: var(--dsw-alias-label-primary)')
  })

  it('separates the row card from the editor it expands into', () => {
    // `bg-layer-3` and `bg-module-platform` both resolve to neutral-bluish-800
    // under the dark theme, so filling the row with either erases the nested
    // editor's boundary. The row is outlined; the fill is the editor's alone.
    expect(block('.editor')).toContain('background: var(--dsw-alias-bg-module-platform)')
    expect(block('.rowCard')).toContain('border: 1px solid var(--dsw-alias-border-l2)')
    expect(block('.rowCard')).not.toMatch(/\bbackground\s*:/)
  })
})
