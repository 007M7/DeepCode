/**
 * Branded provenance identities owned by the plugin-fetch layer. Both cross the
 * fetch → wiring boundary and are opaque tokens that must not be confused with
 * ordinary strings (a package name, a URL) at that seam.
 *
 * @module @deepseek-ai/dsh-plugin-fetch/ids
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** An immutable git commit object id a github fetch pins to. */
export type CommitSha = Branded<'CommitSha'>

/**
 * Construct a {@link CommitSha}, validating the hexadecimal object-id shape.
 * @param value - lowercase hex of an abbreviated or full commit id (7–64 chars, covering SHA-1 and SHA-256).
 * @returns the branded commit id.
 */
export function commitSha(value: string): CommitSha {
  if (!/^[0-9a-f]{7,64}$/.test(value)) {
    throw new Error(`invalid commit sha: ${JSON.stringify(value)}`)
  }
  return value as CommitSha
}

/** A Subresource Integrity string an npm fetch pins to. */
export type Integrity = Branded<'Integrity'>

/**
 * Construct an {@link Integrity}, validating the SRI `<algorithm>-<base64>` shape.
 * @param value - a single SRI entry using sha256, sha384, or sha512.
 * @returns the branded integrity string.
 */
export function integrity(value: string): Integrity {
  if (!/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`invalid subresource integrity: ${JSON.stringify(value)}`)
  }
  return value as Integrity
}
