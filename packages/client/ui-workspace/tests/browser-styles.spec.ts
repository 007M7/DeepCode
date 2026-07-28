/**
 * WorkspaceBrowser scroll-region style contract, asserted against the CSS text
 * on disk: the session list reserves its scrollbar gutter so the scrollbar
 * cannot overlay row trailing content, and reserves it whether or not the list
 * currently overflows so expanding a group does not shift rows sideways.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/WorkspaceBrowser.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one class rule, keyed by property with whitespace collapsed.
 * Declaration order and trailing semicolons are normalized away.
 * @param className - local class name, without the leading dot.
 * @returns the rule's declarations, or undefined when no such rule exists.
 */
function declarations(className: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const match = new RegExp(String.raw`(^|[\s,}])\.${className}\s*\{([^{}]*)\}`).exec(withoutComments)
  if (match === null) return undefined
  const found = new Map<string, string>()
  // The body group is unconditional in the pattern; the fallback only satisfies
  // noUncheckedIndexedAccess.
  for (const part of (match[2] ?? '').split(';')) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
  }
  return found
}

describe('WorkspaceBrowser.module.css list', () => {
  const list = declarations('list')

  it('is the scrolling region', () => {
    expect(list).toBeDefined()
    expect(list!.get('overflow-y')).toBe('auto')
  })

  it('reserves the scrollbar gutter unconditionally', () => {
    // Row trailing content sits flush against the row's right padding, so an
    // overlay scrollbar covers it. `stable` keeps the reservation when the list
    // is short enough not to scroll, so expanding a group does not shift rows.
    expect(list!.get('scrollbar-gutter')).toBe('stable')
  })
})
