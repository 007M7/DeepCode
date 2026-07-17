/**
 * Content identity for workspace instruction duplicate suppression.
 *
 * @module @deepseek-ai/dsh-workspace-context/digest
 */

import { createHash } from 'node:crypto'

/**
 * Compute the content identity used across instruction loading and session state.
 * @param content - exact UTF-8 instruction text.
 * @returns lowercase SHA-1 digest in hexadecimal form.
 */
export function instructionContentSha1(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}
