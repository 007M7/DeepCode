/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from 'node-addon-landlock-run'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** This policy's read denials, canonical and deduplicated like the writable roots. */
function denyPaths(policy: SandboxPolicy): string[] {
  return [...new Set((policy.readDenyPaths ?? []).map(path => canonicalPath(path)))]
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  // Read denials come last so a workspace bind can never re-expose one.
  // `/dev/null` over the path reads as empty; the `-try` form tolerates a
  // path that does not exist yet (no credential stored so far).
  for (const path of denyPaths(policy)) args.push('--ro-bind-try', '/dev/null', path)
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  // Landlock grants are a pure allow-list: a read grant on `/` cannot be
  // subtracted from, so a requested read denial is unenforceable here. The
  // provider reports `partial` enforcement for exactly this case rather than
  // pretending the boundary exists.
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  // SBPL applies the last matching rule, so the read denial is appended after
  // every allow above and governs both reads and writes of those paths. Both
  // filters are emitted so a denial may name a file or a directory.
  const denied = denyPaths(policy)
  if (denied.length > 0) {
    const filters = denied.map(path => `(literal ${sbplString(path)}) (subpath ${sbplString(path)})`).join(' ')
    forms.push(`(deny file-read* file-write* ${filters})`)
  }
  return ['-p', forms.join(' ')]
}
