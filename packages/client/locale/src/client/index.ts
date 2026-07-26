/**
 * Browser-side locale registry. Bound translation functions retain stable
 * identity for injected consumers. The plugin also registers the Language
 * preference row into the settings General section — the locale feature owns
 * its own settings surface.
 */
import type { Context } from 'cordis'
import { deferRegistration, type BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { en } from '../locales/en.ts'
import { zh } from '../locales/zh.ts'
import type { LanguageRowInjected } from './LanguageRow.tsx'
import { LanguageRow } from './LanguageRow.tsx'
import { createLanguageRowStore } from './settings-store.ts'

export type { LanguageRowComponentProps, LanguageRowInjected } from './LanguageRow.tsx'
export type { LanguageOptionRow, LanguageRowState } from './settings-store.ts'
export type { SettingsGeneralItemOwnerProps } from './settings-contract.ts'

/** Translate a key with optional params. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Locale dictionary: flat key to template string ({name} placeholders). */
export type LocaleDict = Record<string, string>

/** Locale identifier: the two shipped locales. */
export type LocaleId = 'zh' | 'en'

/** One selectable locale: id plus its self-described display name. */
export interface LocaleDefinition {
  /** Locale id (persisted; the setLocale argument). */
  id: LocaleId
  /** Display name in its own language (中文 / English). */
  label: string
}

/** Immutable locale state published on every change. */
export interface LocaleSnapshot {
  /** Active locale id. */
  active: LocaleId
  /** Selectable locales in display order. */
  locales: readonly LocaleDefinition[]
  /** Monotonic change counter (registry or active changes). */
  revision: number
}

declare module 'cordis' {
  interface Context {
    locale: LocaleService
  }
  interface Events {
    /**
     * Locale state changed (active locale switched or registry updated).
     * @param snapshot - Current immutable locale snapshot.
     * @mode emit
     */
    'locale/change'(snapshot: LocaleSnapshot): void
  }
}

/** Fallback locale consulted after the active locale misses (also the default). */
export const FALLBACK_LOCALE: LocaleId = 'zh'

/** Shared namespace for shell-level texts. */
export const COMMON_NS = 'common'

/** Namespace owning this feature's settings-row copy. */
export const SETTINGS_NS = 'settings.locale'

/** localStorage key holding the persisted locale id. */
export const STORAGE_KEY = 'dsh.locale'

/** The two shipped locales. */
const LOCALES: readonly LocaleDefinition[] = Object.freeze([
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
])

/**
 * Dictionary registry plus locale preference. Lookup chain per key: active
 * locale -> zh fallback -> the key itself (missing text stays visible, fail
 * loud in the UI rather than blank). Reads go through {@link getLocale};
 * writes only through {@link setLocale}; continuous sync only through the
 * `locale/change` event.
 */
export class LocaleService {
  private dicts = new Map<string, Map<string, LocaleDict>>()
  private bound = new Map<string, Translate>()
  private snapshot: LocaleSnapshot
  private readonly ctx: Context

  /**
   * @param ctx - owning context (change events are emitted on it).
   */
  constructor(ctx: Context) {
    this.ctx = ctx
    this.snapshot = Object.freeze({ active: restorePreference(), locales: LOCALES, revision: 0 })
  }

  /**
   * Read the current immutable locale snapshot.
   * @returns the current snapshot (stable reference until the next change).
   */
  getLocale(): LocaleSnapshot {
    return this.snapshot
  }

  /**
   * Switch the active locale — the only preference write entry. Persists the
   * id and emits `locale/change`.
   * @param id - a registered locale id; unknown ids throw.
   */
  setLocale(id: string): void {
    const match = this.snapshot.locales.find(l => l.id === id)
    if (match === undefined) throw new Error(`locale "${id}" is not registered`)
    if (this.snapshot.active === match.id) return
    this.snapshot = Object.freeze({
      active: match.id,
      locales: this.snapshot.locales,
      revision: this.snapshot.revision + 1,
    })
    persistPreference(match.id)
    this.ctx.emit('locale/change', this.snapshot)
  }

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
    if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
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
   * @returns the translate function (reads the active locale at call time).
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

  private translate(ns: string, key: string, params?: Record<string, unknown>): string {
    const locales = this.dicts.get(ns)
    const template = locales?.get(this.snapshot.active)?.[key]
      ?? locales?.get(FALLBACK_LOCALE)?.[key]
      ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
}

/** Read the persisted locale id; unknown or unreadable values fall back to zh. */
function restorePreference(): LocaleId {
  // Non-browser runs (node e2e booting the client tree) have no localStorage.
  if (typeof localStorage === 'undefined') return FALLBACK_LOCALE
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    // Storage access can throw (privacy mode); the default below covers it.
  }
  return FALLBACK_LOCALE
}

/** Persist the locale id; storage failures are non-fatal (preference resets next boot). */
function persistPreference(id: LocaleId): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Storage access can throw (privacy mode / quota); the preference simply
    // does not survive the session.
  }
}

/** Required services: the slot registry (the feature registers its own settings row). */
export const inject = ['slots']

/**
 * Client plugin body: provide the locale service with base dictionaries and
 * register the feature-owned Language preference row into the General
 * section's item slot (a feature owns its settings surface).
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const locale = new LocaleService(ctx)
  locale.register(COMMON_NS, 'zh', zh)
  locale.register(COMMON_NS, 'en', en)
  locale.register(SETTINGS_NS, 'zh', { 'language.title': '语言' })
  locale.register(SETTINGS_NS, 'en', { 'language.title': 'Language' })
  ctx.provide('locale', locale)

  const store = createLanguageRowStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (snapshot: LocaleSnapshot): void => {
    bound?.sync(
      snapshot.active,
      snapshot.locales.map(l => ({ id: l.id, label: l.label })),
      snapshot.revision,
    )
  }
  ctx.on('locale/change', sync)
  const injected = (actions: BoundActions<typeof store>): LanguageRowInjected => {
    bound = actions
    // Re-sync from the getter so no event is lost between registration and
    // first render (the store's revision guard drops stale duplicates).
    sync(locale.getLocale())
    return {
      t: locale.bind(SETTINGS_NS),
      setLocale: (id) => { locale.setLocale(id) },
    }
  }
  ctx.effect(() => {
    const deferred = deferRegistration(ctx.slots, 'settings.general.item', LanguageRow, () =>
      ctx.slots.register({
        name: 'settings.general.item',
        id: 'language',
        order: 0,
        store,
        inject: injected,
      }, LanguageRow))
    return () => { deferred.dispose() }
  }, 'locale: language settings row registration')
}
