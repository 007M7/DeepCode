// @vitest-environment jsdom
// ThemePresenter behavior account: the palette attribute follows
// active.colorScheme only, token variables replace the previous apply's set,
// and dispose retracts everything the presenter wrote.

import { beforeEach, describe, expect, it } from 'vitest'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { DARK_ATTRIBUTE, ThemePresenter } from '@deepseek-ai/dsh-client-ui-layout/src/client/theme-presenter.ts'

function snapshot(colorScheme: 'light' | 'dark', tokens: Record<string, string> = {}): ThemeSnapshot {
  // The presenter must key off colorScheme, not the id — keep them distinct.
  const active = { id: `${colorScheme}-test`, colorScheme, tokens }
  return { preference: colorScheme, active, themes: [active], revision: 1 }
}

beforeEach(() => {
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.removeAttribute('style')
})

describe('ThemePresenter', () => {
  it('light scheme leaves the dark attribute absent', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('light'))
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('dark scheme sets the attribute; switching back to light removes it', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark'))
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    presenter.apply(snapshot('light'))
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
  })

  it('applies tokens as inline variables and clears the previous set on theme change', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111', '--dsw-alias-fg': '#eee' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#111')
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('#eee')
    presenter.apply(snapshot('light', { '--dsw-alias-bg': '#fff' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#fff')
    // The old theme's extra variable is gone, not merged.
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('')
  })

  it('dispose removes the attribute and every applied variable, sparing foreign inline styles', () => {
    document.body.style.setProperty('--foreign', 'kept')
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111' }))
    presenter.dispose()
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('')
    expect(document.body.style.getPropertyValue('--foreign')).toBe('kept')
  })
})
