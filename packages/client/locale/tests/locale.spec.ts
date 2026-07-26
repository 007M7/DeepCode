// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { LocaleService, STORAGE_KEY } from '@deepseek-ai/dsh-client-locale/client'

const make = (): { ctx: Context; svc: LocaleService; events: LocaleSnapshot[] } => {
  const ctx = new Context()
  const events: LocaleSnapshot[] = []
  ctx.on('locale/change', (snapshot) => { events.push(snapshot) })
  return { ctx, svc: new LocaleService(ctx), events }
}

describe('LocaleService', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('translates through the active-locale -> zh -> key chain', () => {
    const { svc } = make()
    svc.register('ns', 'zh', { hello: '你好', onlyZh: '仅中文' })
    svc.register('ns', 'en', { hello: 'Hello' })
    const t = svc.bind('ns')
    expect(svc.getLocale().active).toBe('zh')
    expect(t('hello')).toBe('你好')
    svc.setLocale('en')
    expect(t('hello')).toBe('Hello')
    expect(t('onlyZh')).toBe('仅中文')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('interpolates {name} params and leaves unknown placeholders intact', () => {
    const { svc } = make()
    svc.register('ns', 'zh', { greet: '你好，{name}！第 {n} 次', partial: '{known} 与 {unknown}' })
    const t = svc.bind('ns')
    expect(t('greet', { name: '世界', n: 2 })).toBe('你好，世界！第 2 次')
    expect(t('partial', { known: 'A' })).toBe('A 与 {unknown}')
  })

  it('bind returns a stable per-namespace function identity', () => {
    const { svc } = make()
    expect(svc.bind('a')).toBe(svc.bind('a'))
    expect(svc.bind('a')).not.toBe(svc.bind('b'))
  })

  it('rejects duplicate (ns, locale) and disposer only removes its own dict', () => {
    const { svc } = make()
    const dispose = svc.register('ns', 'zh', { k: 'v1' })
    expect(() => svc.register('ns', 'zh', { k: 'v2' })).toThrow('already has locale')
    dispose()
    const t = svc.bind('ns')
    expect(t('k')).toBe('k')
    svc.register('ns', 'zh', { k: 'v2' })
    expect(t('k')).toBe('v2')
    dispose()
    expect(t('k')).toBe('v2')
  })

  it('setLocale persists, republishes an immutable snapshot, and no-ops on same value', () => {
    const { svc, events } = make()
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en')
    expect(events).toHaveLength(1)
    expect(events[0]).toBe(svc.getLocale())
    expect(events[0]!.revision).toBe(1)
    svc.setLocale('en')
    expect(events).toHaveLength(1)
  })

  it('throws on unknown locale ids', () => {
    const { svc } = make()
    expect(() => { svc.setLocale('fr') }).toThrow('not registered')
  })

  it('restores a persisted locale and falls back to zh on garbage', () => {
    localStorage.setItem(STORAGE_KEY, 'en')
    expect(make().svc.getLocale().active).toBe('en')
    localStorage.setItem(STORAGE_KEY, 'fr')
    expect(make().svc.getLocale().active).toBe('zh')
  })

  it('runs without localStorage (node boots): defaults on read, no-op on write', () => {
    vi.stubGlobal('localStorage', undefined)
    try {
      const { svc } = make()
      expect(svc.getLocale().active).toBe('zh')
      svc.setLocale('en')
      expect(svc.getLocale().active).toBe('en')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('exposes the two shipped locales with self-described labels', () => {
    const { svc } = make()
    expect(svc.getLocale().locales).toEqual([
      { id: 'zh', label: '中文' },
      { id: 'en', label: 'English' },
    ])
  })
})
