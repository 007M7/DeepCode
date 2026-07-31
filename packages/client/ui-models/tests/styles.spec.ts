import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')

describe('ModelsSection theme styles', () => {
  it('uses the shared theme tokens without light-only fallbacks', () => {
    expect(css).not.toMatch(/var\(--(?:surface|text-|border|accent-strong)/)
    expect(css).toContain('background: var(--dsw-alias-bg-layer-3)')
    expect(css).toContain('color: var(--dsw-alias-label-primary)')
  })
})
