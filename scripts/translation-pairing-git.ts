/** Git-blob operations owned by the bilingual pairing workflow. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Full SHA-1 Git blob hash (the 40-hex format used by pairing records). */
export function gitBlobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/**
 * Persist exact working-tree bytes so a pairing record can later recover them
 * with `git cat-file`, even when they have never appeared in the index or a
 * commit. The returned object ID is checked against the pairing format's own
 * content hash before the caller writes a sidecar.
 */
export function storeGitBlob(root: string, content: Buffer): string {
  const expected = gitBlobHash(content)
  const result = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], {
    input: content,
    maxBuffer: 1 << 26,
  })
  if (result.error) {
    throw new Error(`git hash-object -w --stdin failed: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(`git hash-object -w --stdin failed with status ${String(result.status)}: ${result.stderr.toString('utf8').trim()}`)
  }
  const stored = result.stdout.toString('utf8').trim()
  if (stored !== expected) {
    throw new Error(`git hash-object -w --stdin returned unexpected object ID ${JSON.stringify(stored)}; expected ${expected}`)
  }
  return stored
}
