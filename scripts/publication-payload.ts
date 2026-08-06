/** Publication payload policy shared by static manifests and packed tarballs. */

/** Normalize a package manifest path or npm tarball member to its payload-relative path. */
function payloadPath(file: string): string {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  return normalized.startsWith('package/') ? normalized.slice('package/'.length) : normalized
}

/** Whether a package payload path exposes source or declaration-map intermediates. */
export function isForbiddenPublicationFile(file: string): boolean {
  const normalized = payloadPath(file)
  return normalized === 'src'
    || normalized.startsWith('src/')
    || normalized.endsWith('.d.ts.map')
}

/** Reject source and declaration-map members in a packed npm tarball. */
export function validateTarballPayload(files: readonly string[], context: string): void {
  for (const file of files) {
    if (!isForbiddenPublicationFile(file)) continue
    const normalized = payloadPath(file)
    if (normalized === 'src' || normalized.startsWith('src/')) {
      throw new Error(`${context} publishes source file ${file}`)
    }
    throw new Error(`${context} publishes declaration map ${file}`)
  }
}
