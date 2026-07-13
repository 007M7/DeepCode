/**
 * Build-time projection from canonical repository Markdown into VitePress.
 *
 * The generated tree is disposable: sources stay in their owning `docs/`
 * tier, while this adapter rewrites cross-source links for the public site.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, posix, relative, resolve, sep } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'
import { docsPages, type DocsLocale, type DocsPage } from '../website/docs.ts'

const REPOSITORY_URL = 'https://github.com/deepseek-harness/deepseek-harness'
const root = resolve(import.meta.dirname, '..')
const generatedRoot = resolve(root, 'website/.generated')

interface Replacement {
  start: number
  end: number
  value: string
}

/** Inputs for rewriting one canonical Markdown page. */
export interface RewriteMarkdownOptions {
  locale: DocsLocale
  sourcePath: string
  route: string
  pages: DocsPage[]
  repoRoot: string
  repositoryRef: string
}

function repoPath(absPath: string, repoRoot: string): string {
  return relative(repoRoot, absPath).split(sep).join('/')
}

function isExternalOrSiteAbsolute(url: string): boolean {
  return url.startsWith('#')
    || url.startsWith('//')
    || url.startsWith('/')
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

function splitTarget(url: string): { path: string; suffix: string } {
  const boundary = url.search(/[?#]/)
  if (boundary === -1) return { path: url, suffix: '' }
  return { path: url.slice(0, boundary), suffix: url.slice(boundary) }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    throw new Error(`project-doc-site: malformed percent escape in ${JSON.stringify(path)}.`)
  }
}

function routeTarget(fromRoute: string, toRoute: string, suffix: string): string {
  const target = posix.relative(posix.dirname(fromRoute), toRoute)
  return `${target.startsWith('.') ? target : `./${target}`}${suffix}`
}

function sourceMap(pages: DocsPage[]): Map<string, Map<DocsLocale, DocsPage>> {
  const map = new Map<string, Map<DocsLocale, DocsPage>>()
  for (const page of pages) {
    for (const source of [page.source, ...(page.sourceAliases ?? [])]) {
      const localized = map.get(source) ?? new Map<DocsLocale, DocsPage>()
      if (localized.has(page.locale)) {
        throw new Error(`project-doc-site: duplicate source or alias ${JSON.stringify(source)} for locale ${JSON.stringify(page.locale)}.`)
      }
      localized.set(page.locale, page)
      map.set(source, localized)
    }
  }
  return map
}

function resolveRepositoryTarget(sourceAbs: string, rawPath: string, repoRoot: string): { absPath: string; line?: number } {
  const decoded = decodePath(rawPath)
  let absPath = resolve(dirname(sourceAbs), decoded)
  if (existsSync(absPath)) return { absPath }

  const lineMatch = decoded.match(/:(\d+)$/)
  if (lineMatch !== null) {
    const lineText = lineMatch[1]
    if (lineText === undefined) throw new Error('project-doc-site: line suffix matched without a line number.')
    absPath = resolve(dirname(sourceAbs), decoded.slice(0, -lineMatch[0].length))
    if (existsSync(absPath)) return { absPath, line: Number.parseInt(lineText, 10) }
  }

  if (extname(decoded) === '') {
    const markdown = resolve(dirname(sourceAbs), `${decoded}.md`)
    if (existsSync(markdown)) return { absPath: markdown }
    const index = resolve(dirname(sourceAbs), decoded, 'index.md')
    if (existsSync(index)) return { absPath: index }
  }

  throw new Error(`project-doc-site: ${repoPath(sourceAbs, repoRoot)} links to missing path ${JSON.stringify(rawPath)}.`)
}

function githubTarget(
  absPath: string,
  line: number | undefined,
  suffix: string,
  repositoryRef: string,
  repoRoot: string,
  image: boolean,
): string {
  const path = repoPath(absPath, repoRoot)
  if (image) return `https://raw.githubusercontent.com/deepseek-harness/deepseek-harness/${repositoryRef}/${path}${suffix}`
  const kind = lstatSync(absPath).isDirectory() ? 'tree' : 'blob'
  const lineSuffix = line === undefined ? suffix : `#L${line}`
  return `${REPOSITORY_URL}/${kind}/${repositoryRef}/${path}${lineSuffix}`
}

/**
 * Rewrite repository-relative links without reserializing Markdown.
 *
 * @param source Markdown text from the canonical file.
 * @param options Source, route, manifest, and repository context.
 * @returns Markdown whose published links resolve inside the site or to GitHub.
 */
export function rewriteMarkdown(source: string, options: RewriteMarkdownOptions): string {
  const sourceAbs = resolve(options.repoRoot, options.sourcePath)
  const published = sourceMap(options.pages)
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const replacements: Replacement[] = []

  const rewrite = (node: Nodes & { url: string }): void => {
    if (isExternalOrSiteAbsolute(node.url)) return
    const { path, suffix } = splitTarget(node.url)
    if (path === '') return
    const { absPath, line } = resolveRepositoryTarget(sourceAbs, path, options.repoRoot)
    const targetPath = repoPath(absPath, options.repoRoot)
    const page = published.get(targetPath)?.get(options.locale)
    const nextUrl = page === undefined
      ? githubTarget(absPath, line, suffix, options.repositoryRef, options.repoRoot, node.type === 'image')
      : routeTarget(options.route, page.route, suffix)

    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) {
      throw new Error(`project-doc-site: link ${JSON.stringify(node.url)} has no source offsets.`)
    }
    const rawNode = source.slice(start, end)
    const urlOffset = rawNode.lastIndexOf(node.url)
    if (urlOffset === -1) {
      throw new Error(`project-doc-site: cannot locate raw target ${JSON.stringify(node.url)} in ${JSON.stringify(rawNode)}.`)
    }
    replacements.push({
      start: start + urlOffset,
      end: start + urlOffset + node.url.length,
      value: nextUrl,
    })
  }

  const visit = (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node) rewrite(node)
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)

  let projected = source
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    projected = projected.slice(0, replacement.start) + replacement.value + projected.slice(replacement.end)
  }
  return projected
}

/**
 * Record the canonical edit target in VitePress frontmatter.
 *
 * @param markdown Projected Markdown content.
 * @param sourcePath Repository-relative canonical source path.
 * @returns Markdown with an `editSource` frontmatter field.
 */
export function addProjectionFrontmatter(markdown: string, sourcePath: string): string {
  const field = `editSource: ${JSON.stringify(sourcePath)}`
  if (markdown.startsWith('---\n')) return markdown.replace('---\n', `---\n${field}\n`)
  return `---\n${field}\n---\n\n${markdown}`
}

/** Canonical Markdown files watched by the local VitePress dev server. */
export function docsSourceFiles(): string[] {
  return [...new Set(docsPages.map(page => resolve(root, page.source)))]
}

/** Rebuild the disposable VitePress source tree from the publication manifest. */
export function projectDocs(): void {
  const routes = new Set<string>()
  const repositoryRef = process.env.GITHUB_SHA ?? 'master'
  rmSync(generatedRoot, { recursive: true, force: true })

  for (const page of docsPages) {
    if (routes.has(page.route)) throw new Error(`project-doc-site: duplicate route ${JSON.stringify(page.route)}.`)
    routes.add(page.route)
    const sourceAbs = resolve(root, page.source)
    if (!existsSync(sourceAbs) || !lstatSync(sourceAbs).isFile()) {
      throw new Error(`project-doc-site: source ${JSON.stringify(page.source)} does not exist or is not a file.`)
    }
    const output = resolve(generatedRoot, page.route)
    mkdirSync(dirname(output), { recursive: true })
    const markdown = readFileSync(sourceAbs, 'utf8')
    const projected = rewriteMarkdown(markdown, {
      sourcePath: page.source,
      locale: page.locale,
      route: page.route,
      pages: docsPages,
      repoRoot: root,
      repositoryRef,
    })
    writeFileSync(output, addProjectionFrontmatter(projected, page.source))
  }
}
