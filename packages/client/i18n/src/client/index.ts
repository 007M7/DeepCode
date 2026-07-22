/**
 * i18n plugin, browser half: namespace x locale dictionary registry with a
 * bound translate function whose reference is stable (safe for inject
 * surfaces). Mounts ctx.i18n and seeds the zh/en base dictionaries.
 * Contract: api-contracts v3 section 8.
 */
import type { Context } from 'cordis'
// The snapshot-store engine lives in runtime (store relocation): framework
// data stores like this locale cell use it directly. The store carries no
// hook — a React consumer binds a selector hook via web-react's
// bindSnapshotSelector at its own seam (none exists today; the current
// consumers are translate() reads and test-side subscribe/set).
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { en } from '../locales/en.ts'
import { zh } from '../locales/zh.ts'

/** Translate a key with optional params. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Locale dictionary: flat key to template string ({name} placeholders). */
export type LocaleDict = Record<string, string>

declare module 'cordis' {
  interface Context {
    i18n: I18nService
  }
}

/** Fallback locale consulted after the active locale misses. */
export const FALLBACK_LOCALE = 'zh'

/** Shared namespace for shell-level texts. */
export const COMMON_NS = 'common'

/**
 * Dictionary registry plus locale switch. Lookup chain per key: active locale
 * -> zh fallback -> the key itself (missing text stays visible, fail loud in
 * the UI rather than blank).
 */
export class I18nService {
  private dicts = new Map<string, Map<string, LocaleDict>>()
  private bound = new Map<string, Translate>()
  private localeStore = createSnapshotStore<string>(FALLBACK_LOCALE)

  /**
   * Register a dictionary for a namespace and locale. Duplicate (ns, locale)
   * throws (single occupant; a namespace's texts have one owner).
   * @param ns - namespace.
   * @param locale - locale tag (zh/en to start).
   * @param dict - dictionary.
   * @returns disposer (idempotent).
   */
  register(ns: string, locale: string, dict: LocaleDict): () => void {
    let locales = this.dicts.get(ns)
    if (!locales) {
      locales = new Map()
      this.dicts.set(ns, locales)
    }
    if (locales.has(locale)) throw new Error(`i18n namespace "${ns}" already has locale "${locale}"`)
    locales.set(locale, dict)
    return () => {
      const owner = this.dicts.get(ns)
      if (owner?.get(locale) === dict) owner.delete(locale)
    }
  }

  /**
   * Bind a namespace to a translate function. The returned reference is
   * stable per namespace (repeat binds return the same function), so it can
   * ride inject surfaces without breaking memoization.
   * @param ns - namespace.
   * @returns the translate function (reads the locale store at call time).
   */
  bind(ns: string): Translate {
    let t = this.bound.get(ns)
    if (!t) {
      t = (key, params) => this.translate(ns, key, params)
      this.bound.set(ns, t)
      return t
    }
    return t
  }

  /** Active locale store (switching re-renders the tree; low frequency). */
  get locale(): SnapshotStore<string> {
    return this.localeStore
  }

  private translate(ns: string, key: string, params?: Record<string, unknown>): string {
    const locales = this.dicts.get(ns)
    const template = locales?.get(this.localeStore.getSnapshot())?.[key]
      ?? locales?.get(FALLBACK_LOCALE)?.[key]
      ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
}

/** Required services (none; the loader passes the export surface as an object plugin). */
export const inject: string[] = []

/**
 * Client plugin body: provide the i18n service with base dictionaries.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const i18n = new I18nService()
  i18n.register(COMMON_NS, 'zh', zh)
  i18n.register(COMMON_NS, 'en', en)
  ctx.provide('i18n', i18n)
}
