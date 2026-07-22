import { describe, expect, it } from 'vitest'
import { I18nService } from '@deepseek-ai/dsh-client-i18n/client'

describe('I18nService', () => {
  it('translates from the active locale with zh fallback then key passthrough', () => {
    const i18n = new I18nService()
    i18n.register('ns', 'zh', { hello: '你好', onlyZh: '仅中文' })
    i18n.register('ns', 'en', { hello: 'Hello' })
    const t = i18n.bind('ns')
    expect(i18n.locale.getSnapshot()).toBe('zh')
    expect(t('hello')).toBe('你好')
    i18n.locale.set('en')
    expect(t('hello')).toBe('Hello')
    expect(t('onlyZh')).toBe('仅中文')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('interpolates {name} params and leaves unknown placeholders intact', () => {
    const i18n = new I18nService()
    i18n.register('ns', 'zh', { greet: '你好，{name}！第 {n} 次', partial: '{known} 与 {unknown}' })
    const t = i18n.bind('ns')
    expect(t('greet', { name: '世界', n: 2 })).toBe('你好，世界！第 2 次')
    expect(t('partial', { known: 'A' })).toBe('A 与 {unknown}')
    expect(t('greet')).toBe('你好，{name}！第 {n} 次')
  })

  it('bind returns a stable reference per namespace', () => {
    const i18n = new I18nService()
    expect(i18n.bind('a')).toBe(i18n.bind('a'))
    expect(i18n.bind('a')).not.toBe(i18n.bind('b'))
  })

  it('duplicate (ns, locale) throws; disposer unregisters and is idempotent', () => {
    const i18n = new I18nService()
    const dispose = i18n.register('ns', 'zh', { k: 'v1' })
    expect(() => i18n.register('ns', 'zh', { k: 'v2' })).toThrow('already has locale')
    dispose()
    dispose()
    const t = i18n.bind('ns')
    expect(t('k')).toBe('k')
    i18n.register('ns', 'zh', { k: 'v2' })
    expect(t('k')).toBe('v2')
  })

  it('locale store is subscribable (snapshot store contract)', () => {
    const i18n = new I18nService()
    let notified = 0
    i18n.locale.subscribe(() => { notified += 1 })
    i18n.locale.set('en')
    expect(i18n.locale.getSnapshot()).toBe('en')
    expect(notified).toBe(1)
  })
})
