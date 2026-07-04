/**
 * Doc-sync gate: verify every fenced ```mermaid block parses with Mermaid's
 * own parser. Markdown link/type/code gates can say a diagram block exists and
 * is linked, but only Mermaid can catch syntax errors that GitHub would fail to
 * render.
 *
 * Scope matches the Markdown link gate so any Mermaid diagram in repo-authored
 * docs is checked: README.md, README.zh.md, docs/** /*.md,
 * packages/* /*.md, packages/* /* /*.md, examples/** /*.md, AGENTS.md,
 * packages/AGENTS.md, and .agents/skills/** /*.md.
 *
 * Run: `tsx scripts/verify-mermaid.ts`.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { glob } from 'node:fs/promises'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { JSDOM } from 'jsdom'
import type { Nodes } from 'mdast'

const root = resolve(import.meta.dirname, '..')

const PATTERNS = [
  'README.md',
  'README.zh.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'packages/*/*/*.md',
  'examples/**/*.md',
  'AGENTS.md',
  'packages/AGENTS.md',
  '.agents/skills/**/*.md',
]

interface Block {
  file: string
  line: number
  source: string
}

interface Violation {
  file: string
  line: number
  message: string
}

function extractMermaidBlocks(file: string): Block[] {
  const source = readFileSync(resolve(root, file), 'utf8')
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const out: Block[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'code' && node.lang === 'mermaid') {
      out.push({ file, line: node.position?.start.line ?? 0, source: node.value })
    }
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)
  return out
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/\s+/g, ' ').trim()
  return String(error).replace(/\s+/g, ' ').trim()
}

const blocks: Block[] = []
const seen = new Set<string>()
let checkedFiles = 0
for (const pattern of PATTERNS) {
  for await (const match of glob(pattern, { cwd: root })) {
    const real = realpathSync(resolve(root, match))
    if (seen.has(real)) continue
    seen.add(real)
    checkedFiles++
    blocks.push(...extractMermaidBlocks(match))
  }
}

const violations: Violation[] = []
const { window } = new JSDOM('')
Object.defineProperty(globalThis, 'window', { value: window })
Object.defineProperty(globalThis, 'document', { value: window.document })
Object.defineProperty(globalThis, 'navigator', { value: window.navigator })
const mermaid = (await import('mermaid')).default
mermaid.initialize({ startOnLoad: false })
for (const block of blocks) {
  try {
    await mermaid.parse(block.source, { suppressErrors: false })
  } catch (error: unknown) {
    violations.push({ file: block.file, line: block.line, message: formatError(error) })
  }
}

if (violations.length === 0) {
  console.log(`verify-mermaid: ${blocks.length} mermaid block(s) parsed across ${checkedFiles} file(s).`)
  process.exit(0)
}

console.error('verify-mermaid: Mermaid syntax errors found:')
for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line}  ${violation.message}`)
}
process.exit(1)
