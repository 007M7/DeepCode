/**
 * Browser theme registry over the `--dsw-*` token stylesheets. Theme changes
 * update CSS variables and `body[data-ds-dark-theme]` without React renders.
 */
import type { Context } from 'cordis'

/** Theme token dictionary: --dsw-alias-* overrides keyed by variable name. */
export type ThemeTokens = Record<string, string>

declare module 'cordis' {
  interface Context {
    theme: ThemeService
  }
}

/**
 * Theme registry and switcher. `light`/`dark` are built in (the base
 * stylesheets carry both palettes; the dark palette activates via the
 * body[data-ds-dark-theme] attribute). Third-party themes register alias-layer
 * overrides applied as inline CSS variables on body, cascading over whichever
 * base palette the attribute selects.
 */
export class ThemeService {
  private themes = new Map<string, ThemeTokens>([['light', {}], ['dark', {}]])
  private appliedTokens: ThemeTokens = {}
  private active = 'light'

  /**
   * Register a theme. Duplicate id throws (single occupant per id; the
   * built-in pair counts).
   * @param id - theme id.
   * @param tokens - alias-layer overrides (variable name to value).
   * @returns disposer. Disposing the active theme reverts to `light` so the
   * UI never keeps tokens of an unregistered theme.
   */
  register(id: string, tokens: ThemeTokens): () => void {
    if (this.themes.has(id)) throw new Error(`theme "${id}" is already registered`)
    this.themes.set(id, tokens)
    return () => {
      if (!this.themes.delete(id)) return
      if (this.active === id) this.apply('light')
    }
  }

  /**
   * Activate a theme: toggle body[data-ds-dark-theme] (set only for `dark`)
   * and swap the previous theme's inline token overrides for this one's.
   * Unregistered id throws.
   * @param id - registered theme id.
   */
  apply(id: string): void {
    const tokens = this.themes.get(id)
    if (!tokens) throw new Error(`theme "${id}" is not registered`)
    const body = document.body
    for (const name of Object.keys(this.appliedTokens)) body.style.removeProperty(name)
    if (id === 'dark') body.setAttribute('data-ds-dark-theme', '')
    else body.removeAttribute('data-ds-dark-theme')
    for (const [name, value] of Object.entries(tokens)) body.style.setProperty(name, value)
    this.appliedTokens = tokens
    this.active = id
  }

  /**
   * Report the active theme id (initially `light`).
   * @returns the active theme id.
   */
  current(): string {
    return this.active
  }
}

/** Required services (none; the loader passes the export surface as an object plugin). */
export const inject: string[] = []

/**
 * Client plugin body: provide the theme service.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  ctx.provide('theme', new ThemeService())
}
