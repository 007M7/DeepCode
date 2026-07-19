// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { ThemeService } from '@deepseek-ai/dsh-client-ui-theme/client'

describe('ThemeService', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-ds-dark-theme')
    document.body.removeAttribute('style')
  })

  it('starts on light; apply toggles the dark body attribute both ways', () => {
    const theme = new ThemeService()
    expect(theme.current()).toBe('light')
    theme.apply('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(theme.current()).toBe('dark')
    theme.apply('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(theme.current()).toBe('light')
  })

  it('throws on unregistered apply and duplicate register (built-ins included)', () => {
    const theme = new ThemeService()
    expect(() => { theme.apply('sepia') }).toThrow('not registered')
    expect(() => theme.register('light', {})).toThrow('already registered')
    theme.register('sepia', {})
    expect(() => theme.register('sepia', {})).toThrow('already registered')
  })

  it('applies third-party token overrides as body inline vars and swaps them on switch', () => {
    const theme = new ThemeService()
    theme.register('sepia', { '--dsw-alias-bg-base': 'rgb(1, 2, 3)' })
    theme.apply('sepia')
    expect(document.body.style.getPropertyValue('--dsw-alias-bg-base')).toBe('rgb(1, 2, 3)')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    theme.apply('dark')
    expect(document.body.style.getPropertyValue('--dsw-alias-bg-base')).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
  })

  it('disposing the active theme reverts to light; disposer is idempotent', () => {
    const theme = new ThemeService()
    const dispose = theme.register('sepia', { '--dsw-alias-bg-base': 'red' })
    theme.apply('sepia')
    dispose()
    expect(theme.current()).toBe('light')
    expect(document.body.style.getPropertyValue('--dsw-alias-bg-base')).toBe('')
    expect(() => { theme.apply('sepia') }).toThrow('not registered')
    dispose()
    expect(theme.current()).toBe('light')
  })

  it('disposing an inactive theme leaves the active selection untouched', () => {
    const theme = new ThemeService()
    const dispose = theme.register('sepia', {})
    theme.apply('dark')
    dispose()
    expect(theme.current()).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
  })
})
