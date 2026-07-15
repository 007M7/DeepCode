/**
 * Pure parsing and structural helpers for the bilingual-document pairing
 * gate. Kept separate from the CLI so cutoff and signature behavior can be
 * regression-tested without reading or mutating the repository tree.
 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

/** Validated shape of `scripts/translation-pairing.manifest.json`. */
export interface TranslationPairingManifest {
  required: string[]
  excluded: string[]
  /** Date-named documents on or after this day must merge bilingual. */
  requiredSince: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DATED_DOCUMENT = /(?:^|\/)(\d{4}-\d{2}-\d{2})-[^/]*\.md$/

/** Whether a string names one real calendar day in canonical ISO form. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Read one manifest string-array field or fail before enforcement starts. */
function stringArrayField(record: Record<string, unknown>, field: 'required' | 'excluded'): string[] {
  const value = record[field]
  if (!Array.isArray(value)) {
    throw new Error(`translation-pairing.manifest.json: ${field} must be an array of strings`)
  }
  const entries: unknown[] = value
  if (!entries.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error(`translation-pairing.manifest.json: ${field} must be an array of strings`)
  }
  return entries
}

/** Parse and validate the checked-in bilingual manifest. */
export function parseTranslationPairingManifest(content: string): TranslationPairingManifest {
  const value: unknown = JSON.parse(content)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('translation-pairing.manifest.json: expected an object')
  }
  const record = value as Record<string, unknown>
  const requiredSince = record.requiredSince
  if (typeof requiredSince !== 'string' || !isIsoDate(requiredSince)) {
    throw new Error(`translation-pairing.manifest.json: requiredSince must be a valid YYYY-MM-DD date; got ${JSON.stringify(requiredSince)}`)
  }
  return {
    required: stringArrayField(record, 'required'),
    excluded: stringArrayField(record, 'excluded'),
    requiredSince,
  }
}

/** Return the leading date of a `yyyy-mm-dd-*.md` basename, if present. */
export function datedDocumentDate(file: string): string | undefined {
  return DATED_DOCUMENT.exec(file)?.[1]
}

/** Whether a date-named document falls on or after the pairing cutoff. */
export function requiresPairByDate(file: string, requiredSince: string): boolean {
  const date = datedDocumentDate(file)
  return date !== undefined && date >= requiredSince
}

/** The structural surface compared between the two sides of a pair. */
export interface TranslationStructureSignature {
  /** Heading depths in document order (h2 -> 2). */
  headings: number[]
  /** Fenced code blocks verbatim: info string plus content, in order. */
  code: string[]
  /** Row and column count of each table, in order. */
  tables: string[]
  /** Kind, ordered-list start, and direct item count of each list, in order. */
  lists: string[]
  /** Every link target in order; the language switcher is excluded. */
  links: string[]
}

/** Parse Markdown with the same GFM extensions used by the pairing gate. */
export function parseTranslationMarkdown(content: string): Nodes {
  return fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/** Whether the tree contains a link to exactly `target`. */
export function linksTo(tree: Nodes, target: string): boolean {
  let found = false
  const visit = (node: Nodes): void => {
    if (node.type === 'link' && node.url === target) found = true
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return found
}

/** Collect the ordered structural signature, skipping one switcher target. */
export function translationStructureSignature(tree: Nodes, switcherTarget: string): TranslationStructureSignature {
  const sig: TranslationStructureSignature = { headings: [], code: [], tables: [], lists: [], links: [] }
  const visit = (node: Nodes): void => {
    switch (node.type) {
      case 'heading':
        sig.headings.push(node.depth)
        break
      case 'code':
        sig.code.push(`\`\`\`${node.lang ?? ''}${node.meta ? ` ${node.meta}` : ''}\n${node.value}`)
        break
      case 'table':
        sig.tables.push(`${node.children.length}x${node.children[0]?.children.length ?? 0}`)
        break
      case 'list':
        sig.lists.push(node.ordered
          ? `ordered:start=${node.start ?? 1}:items=${node.children.length}`
          : `bullet:items=${node.children.length}`)
        break
      case 'link':
        if (node.url !== switcherTarget) sig.links.push(node.url)
        break
      default:
        // Every other node kind is prose or a container, not part of the signature.
        break
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return sig
}

/** Render a signature element for an error message, truncated for readability. */
function show(value: string | number | undefined): string {
  if (value === undefined) return 'nothing'
  const text = JSON.stringify(value)
  return text.length > 72 ? `${text.slice(0, 72)}…` : text
}

/** Return the first divergence for each structural field; empty means equal. */
export function translationStructureDiff(
  source: TranslationStructureSignature,
  zh: TranslationStructureSignature,
): string[] {
  const out: string[] = []
  const fields: [string, (string | number)[], (string | number)[]][] = [
    ['heading (depth)', source.headings, zh.headings],
    ['code block', source.code, zh.code],
    ['table (row x column count)', source.tables, zh.tables],
    ['list (kind, start, item count)', source.lists, zh.lists],
    ['link target', source.links, zh.links],
  ]
  for (const [field, sourceValues, zhValues] of fields) {
    const length = Math.max(sourceValues.length, zhValues.length)
    for (let index = 0; index < length; index++) {
      if (sourceValues[index] !== zhValues[index]) {
        out.push(`${field} #${index + 1} diverges between the pair: ${show(sourceValues[index])} vs ${show(zhValues[index])}`)
        break
      }
    }
  }
  return out
}
