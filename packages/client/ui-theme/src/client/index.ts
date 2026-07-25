/**
 * Browser theme registry over the `--dsw-*` token stylesheets. The service
 * owns the theme preference (light/dark/system), resolves `system` through
 * `prefers-color-scheme`, and publishes immutable snapshots; it never touches
 * the DOM — ui-layout's presenter consumes the resolved snapshot.
 */
import type { Context } from 'cordis'

/** Theme token dictionary: --dsw-alias-* overrides keyed by variable name. */
export type ThemeTokens = Record<string, string>

/** Theme preference: a concrete theme id or follow-the-OS. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** One selectable theme: id, dark/light semantics, and alias-token overrides. */
export interface ThemeDefinition {
  /** Theme id (the setTheme argument for concrete themes). */
  id: string
  /**
   * Which base palette this theme builds on. The presenter switches
   * `body[data-ds-dark-theme]` from this field — never from the id.
   */
  colorScheme: 'light' | 'dark'
  /** Alias-layer overrides applied as inline CSS variables over the base palette. */
  tokens: ThemeTokens
}

/** Immutable theme state published on every change. */
export interface ThemeSnapshot {
  /** The persisted preference (may be `system`). */
  preference: ThemePreference
  /** The resolved active theme (`system` resolved via prefers-color-scheme). */
  active: ThemeDefinition
  /** Registered themes in registration order. */
  themes: readonly ThemeDefinition[]
  /** Monotonic change counter (registry or active changes). */
  revision: number
}

declare module 'cordis' {
  interface Context {
    theme: ThemeService
  }
  interface Events {
    /**
     * Theme state changed (preference switched, registry updated, or the OS
     * color scheme changed while the preference is `system`).
     * @param snapshot - Current immutable theme snapshot.
     * @mode emit
     */
    'theme/change'(snapshot: ThemeSnapshot): void
  }
}

/** localStorage key holding the persisted theme preference. */
export const STORAGE_KEY = 'dsh.theme'

/** Default preference when nothing (or garbage) is persisted. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

const BUILTIN_THEMES: readonly ThemeDefinition[] = Object.freeze([
  Object.freeze({ id: 'light', colorScheme: 'light' as const, tokens: Object.freeze({}) }),
  Object.freeze({ id: 'dark', colorScheme: 'dark' as const, tokens: Object.freeze({}) }),
])

/**
 * Theme registry and preference owner. `light`/`dark` are built in (the base
 * stylesheets carry both palettes); third-party themes register alias-layer
 * overrides. Reads go through {@link getTheme}; writes only through
 * {@link setTheme}; continuous sync only through the `theme/change` event.
 * The service holds the `prefers-color-scheme` media query (environment
 * sensing, not presentation) and re-emits when the OS scheme flips while the
 * preference is `system`.
 */
export class ThemeService {
  private readonly ctx: Context
  private themes: ThemeDefinition[] = [...BUILTIN_THEMES]
  private preference: ThemePreference
  private revision = 0
  private snapshot: ThemeSnapshot
  private readonly media: MediaQueryList | undefined

  /**
   * @param ctx - owning context (change events are emitted on it; the
   * media-query listener is released through ctx.effect on dispose).
   */
  constructor(ctx: Context) {
    this.ctx = ctx
    this.preference = restorePreference()
    // Non-browser runs (node e2e booting the client tree) have no matchMedia.
    this.media = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)')
    this.snapshot = this.buildSnapshot()
    if (this.media !== undefined) {
      const media = this.media
      const onChange = (): void => {
        if (this.preference !== 'system') return
        this.publish()
      }
      ctx.effect(() => {
        media.addEventListener('change', onChange)
        return () => { media.removeEventListener('change', onChange) }
      }, 'ui-theme: prefers-color-scheme listener')
    }
  }

  /**
   * Read the current immutable theme snapshot.
   * @returns the current snapshot (stable reference until the next change).
   */
  getTheme(): ThemeSnapshot {
    return this.snapshot
  }

  /**
   * Switch the theme preference — the only preference write entry. Persists
   * the preference and emits `theme/change`.
   * @param id - a registered theme id or `system`; unknown ids throw.
   */
  setTheme(id: string): void {
    if (id !== 'system' && !this.themes.some(t => t.id === id)) {
      throw new Error(`theme "${id}" is not registered`)
    }
    if (this.preference === id) return
    this.preference = id as ThemePreference
    persistPreference(this.preference)
    this.publish()
  }

  /**
   * Register a theme. Duplicate id throws (single occupant per id; the
   * built-in pair counts; `system` is a preference, not a registrable id).
   * @param definition - theme id, colorScheme, and alias-token overrides.
   * @returns disposer. Disposing the theme backing the active preference
   * resets the preference to the default so the UI never keeps tokens of an
   * unregistered theme.
   */
  register(definition: ThemeDefinition): () => void {
    if (definition.id === 'system') throw new Error('"system" is a preference, not a registrable theme id')
    if (this.themes.some(t => t.id === definition.id)) {
      throw new Error(`theme "${definition.id}" is already registered`)
    }
    this.themes = [...this.themes, definition]
    this.publish()
    return () => {
      if (!this.themes.some(t => t.id === definition.id)) return
      this.themes = this.themes.filter(t => t.id !== definition.id)
      if (this.preference === definition.id) {
        this.preference = DEFAULT_PREFERENCE
        persistPreference(this.preference)
      }
      this.publish()
    }
  }

  private buildSnapshot(): ThemeSnapshot {
    const resolvedId = this.preference === 'system'
      ? (this.media?.matches === true ? 'dark' : 'light')
      : this.preference
    // Both built-ins always exist; a registered preference id resolves or has
    // been reset by its disposer, so the lookup cannot miss.
    const active = this.themes.find(t => t.id === resolvedId)
    /* v8 ignore next 2 -- needs a registry without light/dark, which register()/dispose() cannot produce */
    if (active === undefined) throw new Error(`theme registry lost "${resolvedId}"`)
    return Object.freeze({
      preference: this.preference,
      active,
      themes: Object.freeze([...this.themes]),
      revision: this.revision,
    })
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    this.ctx.emit('theme/change', this.snapshot)
  }
}

/** Read the persisted preference; unknown or unreadable values fall back to the default. */
function restorePreference(): ThemePreference {
  // Non-browser runs (node e2e booting the client tree) have no localStorage.
  if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCE
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Storage access can throw (privacy mode); the default below covers it.
  }
  return DEFAULT_PREFERENCE
}

/** Persist the preference; storage failures are non-fatal (preference resets next boot). */
function persistPreference(preference: ThemePreference): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Storage access can throw (privacy mode / quota); the preference simply
    // does not survive the session.
  }
}

/** Required services (none; the loader passes the export surface as an object plugin). */
export const inject: string[] = []

/**
 * Client plugin body: provide the theme service.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  ctx.provide('theme', new ThemeService(ctx))
}
