/**
 * Scrollbar stylesheet contract, asserted against the CSS text on disk: every
 * --dsw-alias-scrollbar-* token design-platform.css defines has a consumer,
 * scrollbar.css binds the base-surface pair through the rebindable
 * indirection, and elevated surfaces rebind that indirection in complete
 * pairs. The expected token set is scanned out of design-platform.css, so
 * adding, renaming, or dropping a scrollbar token moves these assertions with
 * it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** One flattened CSS rule: its comma-separated selector parts and its declarations in source order. */
interface CssRule {
  selectors: string[]
  declarations: [property: string, value: string][]
}

const STYLES = new URL('../src/styles/', import.meta.url)
const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, STYLES)), 'utf8')

const platformCss = read('design-platform.css')
const scrollbarCss = read('scrollbar.css')

/** Body attribute selecting the dark palette; ui-layout's ThemePresenter sets it. */
const DARK_ATTRIBUTE = '[data-ds-dark-theme]'
/** Alias tokens under test: the prefix the elevation pairs share. */
const TOKEN_PREFIX = '--dsw-alias-scrollbar-'
/** Prefix of the rebindable indirection scrollbar.css owns. */
const INDIRECTION_PREFIX = '--dsh-scrollbar-'

/**
 * Flatten a stylesheet into rules. Whitespace, declaration order, and trailing
 * semicolons are normalized away; nesting and at-rules are not handled, which
 * no sheet under test uses for scrollbar declarations.
 * @param css - stylesheet text.
 * @returns one entry per rule, in source order.
 */
function parseRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: CssRule[] = []
  // Destructuring defaults only satisfy noUncheckedIndexedAccess; both groups
  // are unconditional in the pattern.
  for (const [, selector = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = body
      .split(';')
      .map(part => part.trim())
      .filter(part => part.includes(':'))
      .map((part): [string, string] => {
        const colon = part.indexOf(':')
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
      })
    rules.push({ selectors: selector.split(',').map(part => part.trim()), declarations })
  }
  return rules
}

/**
 * Custom-property names a value reads.
 * @param value - declaration value, possibly with nested var() calls.
 * @returns every referenced custom-property name, in source order.
 */
function varReferences(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, name = '']) => name)
}

/**
 * Every CSS file shipped as package source, excluding build output and
 * installed dependencies.
 * @returns absolute paths of the stylesheets under packages/.
 */
function packageStylesheets(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'dist') walk(path)
      } else if (entry.name.endsWith('.css')) found.push(path)
    }
  }
  walk(PACKAGES_DIR)
  return found
}

/**
 * Tokens a stylesheet reads through its rendering declarations, following its
 * own custom-property definitions transitively so a token reached only through
 * an indirection counts. The walk starts from the standard-property
 * declarations, so a defined-but-unread indirection contributes nothing.
 * @param rules - parsed rules of one stylesheet.
 * @returns every `--dsw-*` token the sheet's rendering declarations depend on.
 */
function tokensRendered(rules: CssRule[]): Set<string> {
  const definitions = new Map<string, string>()
  const pending: string[] = []
  for (const rule of rules) {
    for (const [property, value] of rule.declarations) {
      if (property.startsWith('--')) definitions.set(property, value)
      else pending.push(value)
    }
  }
  const reached = new Set<string>()
  const visited = new Set<string>()
  while (pending.length > 0) {
    for (const name of varReferences(pending.pop()!)) {
      if (name.startsWith('--dsw-')) reached.add(name)
      if (visited.has(name)) continue
      visited.add(name)
      const definition = definitions.get(name)
      if (definition !== undefined) pending.push(definition)
    }
  }
  return reached
}

const platformRules = parseRules(platformCss)
const scrollbarRules = parseRules(scrollbarCss)
const sorted = (names: Iterable<string>): string[] => [...names].sort()

/**
 * Scrollbar tokens defined by the rules whose selectors carry (or do not
 * carry) the dark palette attribute.
 * @param dark - true to scan the dark blocks, false to scan the light blocks.
 * @returns the scrollbar token names defined there.
 */
function definedTokens(dark: boolean): Set<string> {
  const names = new Set<string>()
  for (const rule of platformRules) {
    if (rule.selectors.every(selector => selector.includes(DARK_ATTRIBUTE)) !== dark) continue
    for (const [property] of rule.declarations) {
      if (property.startsWith(TOKEN_PREFIX)) names.add(property)
    }
  }
  return names
}

const lightTokens = definedTokens(false)
const darkTokens = definedTokens(true)
const allTokens = new Set([...lightTokens, ...darkTokens])

/** Every scrollbar token any package stylesheet references, mapped to the files referencing it. */
const referencedTokens = new Map<string, string[]>()
/** Every indirection property any package stylesheet outside ui-theme declares, mapped to its declaring rules. */
const rebindRules: { file: string; rule: CssRule }[] = []

for (const file of packageStylesheets()) {
  const rules = parseRules(readFileSync(file, 'utf8'))
  for (const rule of rules) {
    let rebinds = false
    for (const [property, value] of rule.declarations) {
      if (property.startsWith(INDIRECTION_PREFIX) && file !== fileURLToPath(new URL('scrollbar.css', STYLES))) rebinds = true
      for (const token of varReferences(value)) {
        if (!token.startsWith(TOKEN_PREFIX)) continue
        referencedTokens.set(token, [...referencedTokens.get(token) ?? [], file])
      }
    }
    if (rebinds) rebindRules.push({ file, rule })
  }
}

describe('design-platform.css scrollbar tokens', () => {
  it('defines the same scrollbar token set in the light and the dark block', () => {
    // A token present only in the light block silently keeps its light value
    // under the dark palette, since the dark block only overrides.
    expect(allTokens.size).toBeGreaterThan(0)
    expect(sorted(lightTokens)).toEqual(sorted(allTokens))
    expect(sorted(darkTokens)).toEqual(sorted(allTokens))
  })

  it('resolves every scrollbar token to a static scale value, not to another alias', () => {
    // The alias layer is the only indirection in the token sheet: an alias
    // pointing at a second alias makes the dark override order-dependent.
    for (const rule of platformRules) {
      for (const [property, value] of rule.declarations) {
        if (!property.startsWith(TOKEN_PREFIX)) continue
        for (const reference of varReferences(value)) {
          expect(reference, `${property}: ${value}`).toMatch(/^--dsw-static-/)
        }
      }
    }
  })
})

describe('scrollbar token consumers', () => {
  it('every defined scrollbar token is referenced by some package stylesheet', () => {
    // Before scrollbar.css existed these tokens had no consumer at all and
    // every scroll container rendered the unthemed UA bar. A fifth token, or a
    // rename on one side only, leaves the new name unreferenced here.
    expect(sorted(referencedTokens.keys())).toEqual(sorted(allTokens))
  })

  it('every referenced scrollbar token is defined in design-platform.css', () => {
    // A dangling var() renders the UA default instead of failing loudly, so a
    // rename has to move the reference and the definition together.
    for (const [token, files] of referencedTokens) {
      expect(allTokens, files.join(', ')).toContain(token)
    }
  })
})

describe('scrollbar.css base-surface binding', () => {
  const rendered = tokensRendered(scrollbarRules)

  it('renders the l1 pair through the rebindable indirection', () => {
    // l1 is the base-surface default the indirection resolves to; the
    // indirection only counts as bound when a rendering declaration reads it.
    expect(rendered).toContain(`${TOKEN_PREFIX}bg-l1`)
    expect(rendered).toContain(`${TOKEN_PREFIX}hover-l1`)
  })

  it('routes the standard property and the WebKit thumb through the same indirection', () => {
    // A rebind on an elevated container has to move the Firefox and the WebKit
    // rendering together, which only holds while both read the same variable.
    const declaration = (property: string, selectorPart: string): string | undefined => scrollbarRules
      .filter(rule => rule.selectors.includes(selectorPart))
      .flatMap(rule => rule.declarations)
      .findLast(([name]) => name === property)?.[1]
    const thumbColor = declaration('scrollbar-color', 'body')
    expect(thumbColor).toBeDefined()
    const indirection = varReferences(thumbColor!)[0]
    expect(indirection).toBe(`${INDIRECTION_PREFIX}thumb`)
    expect(varReferences(declaration('background', '::-webkit-scrollbar-thumb')!)).toEqual([indirection])
  })
})

describe('scrollbar.css selectors', () => {
  const scrollbarColorSelectors = scrollbarRules
    .filter(rule => rule.declarations.some(([property]) => property === 'scrollbar-color'))
    .flatMap(rule => rule.selectors)

  it('declares scrollbar-color only where the body-scoped tokens are visible', () => {
    // design-platform.css defines the alias tokens on `body`, and custom
    // properties inherit downward only: the same declaration on `html` or
    // `:root` resolves to the guaranteed-invalid value, which computes
    // scrollbar-color to `auto` and drops the theming entirely.
    expect(scrollbarColorSelectors.length).toBeGreaterThan(0)
    for (const selector of scrollbarColorSelectors) {
      expect(selector, selector).toMatch(/^body\b/)
    }
  })

  it('defines the indirection where the alias tokens are visible', () => {
    const definesIndirection = ([property, value]: [string, string]): boolean =>
      property.startsWith(INDIRECTION_PREFIX) && value.includes(TOKEN_PREFIX)
    const hosts = scrollbarRules
      .filter(rule => rule.declarations.some(definesIndirection))
      .flatMap(rule => rule.selectors)
    expect(hosts.length).toBeGreaterThan(0)
    for (const selector of hosts) expect(selector, selector).toMatch(/^body\b/)
  })

  it('re-declares the scrollbar properties per element rather than inheriting them', () => {
    // scrollbar-width is not an inherited property, and an inherited
    // scrollbar-color carries the colour already substituted at `body`, which
    // a descendant rebinding the indirection could no longer change.
    expect(scrollbarColorSelectors).toContain('body *')
    const widthSelectors = scrollbarRules
      .filter(rule => rule.declarations.some(([property]) => property === 'scrollbar-width'))
      .flatMap(rule => rule.selectors)
    expect(widthSelectors).toContain('body *')
  })
})

describe('elevated surface rebinds', () => {
  it('at least one surface rebinds the indirection', () => {
    expect(rebindRules.length).toBeGreaterThan(0)
  })

  it('each rebinding rule sets the thumb and the hover variable together', () => {
    // A surface rebinding only the resting colour keeps the l1 hover colour,
    // so the elevation is wrong only while the pointer is over the thumb.
    for (const { file, rule } of rebindRules) {
      const properties = rule.declarations.map(([property]) => property).filter(property => property.startsWith(INDIRECTION_PREFIX))
      expect(sorted(properties), `${file} ${rule.selectors.join(', ')}`).toEqual([
        `${INDIRECTION_PREFIX}thumb-hover`, `${INDIRECTION_PREFIX}thumb`,
      ].sort())
    }
  })

  it('each rebinding rule binds the indirection names scrollbar.css renders', () => {
    // A misspelled property name declares an unused variable, and the surface
    // silently keeps the base-surface colour.
    const rendered = new Set(
      scrollbarRules
        .flatMap(rule => rule.declarations)
        .filter(([property]) => !property.startsWith('--'))
        .flatMap(([, value]) => varReferences(value))
        .filter(name => name.startsWith(INDIRECTION_PREFIX)),
    )
    for (const { file, rule } of rebindRules) {
      for (const [property] of rule.declarations) {
        if (property.startsWith(INDIRECTION_PREFIX)) expect(rendered, `${file}: ${property}`).toContain(property)
      }
    }
  })

  it('every rebind targets the l2 elevation pair', () => {
    for (const { file, rule } of rebindRules) {
      for (const [property, value] of rule.declarations) {
        if (!property.startsWith(INDIRECTION_PREFIX)) continue
        for (const token of varReferences(value)) {
          expect(token, `${file}: ${property}`).toMatch(/-l2$/)
        }
      }
    }
  })
})
