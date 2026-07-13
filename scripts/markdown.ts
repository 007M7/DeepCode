/** Shared Markdown parsing and depth-first traversal for documentation gates. */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

/** One authored Markdown line outside fenced code. */
export interface MarkdownProseLine {
  /** 1-based source line number. */
  index: number
  /** Source text without normalization. */
  raw: string
}

/** Parse GitHub-flavored Markdown with the repository's standard extensions. */
export function parseMarkdown(source: string): Nodes {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/**
 * Visit a Markdown tree depth-first; returning false prunes a node's children.
 * @param node - current tree node.
 * @param visitor - callback invoked before each node's children.
 */
export function visitMarkdown(node: Nodes, visitor: (node: Nodes) => boolean | void): void {
  if (visitor(node) === false) return
  if ('children' in node) {
    for (const child of node.children) visitMarkdown(child, visitor)
  }
}

/**
 * Return source lines outside backtick or tilde fences.
 * @param source - Markdown source whose prose should be retained verbatim.
 * @returns unfenced lines with their original 1-based locations.
 */
export function markdownProseLines(source: string): MarkdownProseLine[] {
  let fence: { marker: '`' | '~'; length: number } | undefined
  const kept: MarkdownProseLine[] = []
  source.split('\n').forEach((raw, i) => {
    const token = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
    if (token !== undefined) {
      const marker = token[0] as '`' | '~'
      if (fence === undefined) {
        fence = { marker, length: token.length }
      } else if (marker === fence.marker && token.length >= fence.length) {
        fence = undefined
      }
      return
    }
    if (fence === undefined) kept.push({ index: i + 1, raw })
  })
  return kept
}
