/**
 * Acceptance-path coverage for fragment validation in `verify-md-links`: a
 * `#fragment` onto a Markdown target — same-file anchors included — must name
 * a real heading slug or explicit `<a id>`, while non-Markdown fragments and
 * external targets stay out of scope.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { documentAnchors, findViolations, githubSlug } from './verify-md-links.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function layout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'md-links-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

function violationsIn(root: string, rel: string): { url: string; reason: string }[] {
  const cache = new Map<string, Set<string>>()
  const anchorsOf = (abs: string): Set<string> => {
    const hit = cache.get(abs)
    if (hit) return hit
    const anchors = documentAnchors(readFileSync(abs, 'utf8'))
    cache.set(abs, anchors)
    return anchors
  }
  return findViolations(join(root, rel), anchorsOf, root).map(({ url, reason }) => ({ url, reason }))
}

describe('documentAnchors', () => {
  it('slugs headings, suffixes repeats, and reads explicit <a id> anchors', () => {
    const anchors = documentAnchors([
      '# My Doc',
      '## Live `events` — mode!',
      '## Repeat',
      '## Repeat',
      '<a id="hand-anchor"></a>',
      '',
    ].join('\n'))
    expect(anchors).toEqual(new Set(['my-doc', 'live-events--mode', 'repeat', 'repeat-1', 'hand-anchor']))
    expect(githubSlug('Security and authority are non-goals')).toBe('security-and-authority-are-non-goals')
  })
})

describe('findViolations fragments', () => {
  it('accepts resolving same-file and cross-file fragments, non-md fragments, and externals', () => {
    const root = layout({
      'a.md': '# A\n\n## Deferred work\n\n[self](#deferred-work) [b](b.md#part-two) [code](x.ts#L10) [ext](https://x.example/#frag)\n',
      'b.md': '# B\n\n## Part two\n',
      'x.ts': 'export {}\n',
    })
    expect(violationsIn(root, 'a.md')).toEqual([])
  })

  it('rejects a same-file fragment that names no heading or <a id>', () => {
    const root = layout({ 'a.md': '# A\n\n[gone](#deferred-work)\n' })
    expect(violationsIn(root, 'a.md')).toEqual([{ url: '#deferred-work', reason: 'anchor' }])
  })

  it('rejects a cross-file fragment missing from the target document', () => {
    const root = layout({
      'a.md': '# A\n\n[stale](b.md#old-heading)\n',
      'b.md': '# B\n\n## New heading\n',
    })
    expect(violationsIn(root, 'a.md')).toEqual([{ url: 'b.md#old-heading', reason: 'anchor' }])
  })

  it('still rejects a missing target file, reported as target not anchor', () => {
    const root = layout({ 'a.md': '# A\n\n[ghost](missing.md#anything)\n' })
    expect(violationsIn(root, 'a.md')).toEqual([{ url: 'missing.md#anything', reason: 'target' }])
  })
})
