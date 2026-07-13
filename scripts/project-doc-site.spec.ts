/** Tests for the documentation website projection adapter. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { docsPages, type DocsPage } from '../website/docs.ts'
import { addProjectionFrontmatter, rewriteMarkdown } from './project-doc-site.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; pages: DocsPage[] } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doc-site-'))
  roots.push(root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'packages'), { recursive: true })
  writeFileSync(join(root, 'docs/a.md'), '# A\n')
  writeFileSync(join(root, 'docs/b.md'), '# B\n')
  writeFileSync(join(root, 'packages/tool.ts'), 'one\ntwo\n')
  writeFileSync(join(root, 'packages/logo.svg'), '<svg/>\n')
  return {
    root,
    pages: [
      { locale: 'root', contentLocale: 'en-US', source: 'docs/a.md', route: 'a.md', label: 'A', sidebar: 'zh-reference', section: 'Test', order: 1 },
      { locale: 'root', contentLocale: 'en-US', source: 'docs/b.md', route: 'reference-root/b.md', label: 'B', sidebar: 'zh-reference', section: 'Test', order: 2 },
      { locale: 'en', contentLocale: 'en-US', source: 'docs/a.md', route: 'en/a.md', label: 'A', sidebar: 'en-reference', section: 'Test', order: 1 },
      { locale: 'en', contentLocale: 'en-US', source: 'docs/b.md', route: 'en/reference/b.md', label: 'B', sidebar: 'en-reference', section: 'Test', order: 2 },
    ],
  }
}

describe('rewriteMarkdown', () => {
  it('maps published pages and pins unpublished source links', () => {
    const { root, pages } = fixture()
    const source = '[B](b.md#part) [source](../packages/tool.ts:2) [web](https://example.com)\n'
    expect(rewriteMarkdown(source, {
      locale: 'en',
      sourcePath: 'docs/a.md',
      route: 'en/a.md',
      pages,
      repoRoot: root,
      repositoryRef: 'abc123',
    })).toBe(
      '[B](./reference/b.md#part) '
      + '[source](https://github.com/deepseek-harness/deepseek-harness/blob/abc123/packages/tool.ts#L2) '
      + '[web](https://example.com)\n',
    )
  })

  it('selects the published target in the current site locale', () => {
    const { root, pages } = fixture()
    expect(rewriteMarkdown('[B](b.md)\n', {
      locale: 'root',
      sourcePath: 'docs/a.md',
      route: 'a.md',
      pages,
      repoRoot: root,
      repositoryRef: 'abc123',
    })).toBe('[B](./reference-root/b.md)\n')
  })

  it('uses raw GitHub content for unpublished images', () => {
    const { root, pages } = fixture()
    expect(rewriteMarkdown('![logo](../packages/logo.svg)\n', {
      locale: 'en',
      sourcePath: 'docs/a.md',
      route: 'en/a.md',
      pages,
      repoRoot: root,
      repositoryRef: 'abc123',
    })).toBe('![logo](https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/abc123/packages/logo.svg)\n')
  })

  it('does not rewrite Markdown-looking text inside code fences', () => {
    const { root, pages } = fixture()
    const source = '```md\n[B](b.md)\n```\n'
    expect(rewriteMarkdown(source, {
      locale: 'en',
      sourcePath: 'docs/a.md',
      route: 'en/a.md',
      pages,
      repoRoot: root,
      repositoryRef: 'abc123',
    })).toBe(source)
  })

  it('fails loud when a relative target is missing', () => {
    const { root, pages } = fixture()
    expect(() => rewriteMarkdown('[missing](missing.md)\n', {
      locale: 'en',
      sourcePath: 'docs/a.md',
      route: 'en/a.md',
      pages,
      repoRoot: root,
      repositoryRef: 'abc123',
    })).toThrow('links to missing path "missing.md"')
  })
})

describe('docsPages locale routes', () => {
  it('publishes the same canonical source at every corresponding locale route', () => {
    const byRoute = new Map(docsPages.map(page => [page.route, page]))
    for (const page of docsPages.filter(page => page.locale === 'root')) {
      const counterpart = byRoute.get(`en/${page.route}`)
      expect(counterpart, page.route).toBeDefined()
      expect(counterpart?.locale).toBe('en')
      expect(counterpart?.source).toBe(page.source)
      expect(counterpart?.contentLocale).toBe(page.contentLocale)
    }
  })
})

describe('addProjectionFrontmatter', () => {
  it('adds frontmatter to an ordinary Markdown page', () => {
    expect(addProjectionFrontmatter('# Guide\n', 'docs/guide.md')).toBe(
      '---\neditSource: "docs/guide.md"\n---\n\n# Guide\n',
    )
  })

  it('extends existing VitePress frontmatter', () => {
    expect(addProjectionFrontmatter('---\nlayout: home\n---\n', 'docs/index.md')).toBe(
      '---\neditSource: "docs/index.md"\nlayout: home\n---\n',
    )
  })
})
