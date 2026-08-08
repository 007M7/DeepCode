/** Resolve a Tool argument path against the session workspace. */

/**
 * Resolve a Tool argument path for the Host opener.
 * @param cwd - session workspace root, when known.
 * @param path - path carried by the Tool arguments.
 * @returns an absolute-or-workspace-relative Host path.
 */
export function resolveToolPath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')) return path
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[/\\]+$/, '')
  const rel = path.replace(/^[/\\]+/, '')
  return `${base}/${rel}`
}
