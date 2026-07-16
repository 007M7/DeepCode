/**
 * Shared fenced-code-block extractor for the Markdown doc gates
 * (`doc-typecheck.ts`, `verify-website-yaml.ts`). One scanner, per-gate
 * classification: each gate maps a fence info string (` ```ts `,
 * ` ```yaml ignore-check `, …) to its own kind tag and receives every
 * classified block with its 1-based opening-fence line.
 */

import { readFileSync } from 'node:fs'

/** One extracted fenced block, classified by the caller's `classify`. */
export interface Fence<K> {
  /** 1-based line of the opening fence. */
  line: number
  kind: K
  code: string
}

/**
 * Extract every fenced block of `absPath` whose info string `classify` maps
 * to a kind. Blocks classified `null` are skipped (their bodies are still
 * consumed, so an unrelated fence can never leak into a tracked one).
 *
 * @param absPath — absolute path of the Markdown file.
 * @param classify — info string (trimmed, e.g. `ts ignore-check`) → kind, or
 *   null for fences this gate does not track.
 * @returns the classified blocks in document order.
 */
export function extractFences<K>(absPath: string, classify: (info: string) => K | null): Fence<K>[] {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const blocks: Fence<K>[] = []
  let open: { line: number; kind: K; body: string[] } | null = null
  let skipping = false

  lines.forEach((raw, i) => {
    const fence = /^```(\s*)(\S.*)?$/.exec(raw)
    if (!fence) {
      if (open) open.body.push(raw)
      return
    }
    if (open) {
      blocks.push({ line: open.line, kind: open.kind, code: open.body.join('\n') })
      open = null
      return
    }
    if (skipping) {
      skipping = false
      return
    }
    const kind = classify((fence[2] ?? '').trim())
    if (kind !== null) open = { line: i + 1, kind, body: [] }
    else skipping = true
  })
  return blocks
}
