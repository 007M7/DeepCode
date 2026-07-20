/** Verify every compiled companion through its package self-reference under plain Node. */

import { spawnSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const loaderUrl = pathToFileURL(resolve(root, 'vendor/loader/lib/index.js')).href
const failures = []
const manifests = globSync('packages/*/*/package.json', { cwd: root }).sort()

for (const manifestPath of manifests) {
  const packageDir = dirname(resolve(root, manifestPath))
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'))
  const packageName = manifest.name
  if (typeof packageName !== 'string' || packageName.length === 0) {
    failures.push(`${manifestPath}: missing package name`)
    continue
  }

  const probe = `
    const companion = await import(${JSON.stringify(`${packageName}/invariant`)});
    const { default: Loader } = await import(${JSON.stringify(loaderUrl)});
    if ('default' in companion) throw new Error('companion has a default export');
    const loader = Object.create(Loader.prototype);
    const unwrapped = loader.unwrapExports(companion);
    if (unwrapped !== companion) throw new Error('Loader collapsed the companion namespace');
    if (typeof unwrapped.name !== 'string') throw new Error('companion name is missing');
    if (!Array.isArray(unwrapped.inject) || !unwrapped.inject.includes('invariants')) {
      throw new Error('companion does not inject invariants');
    }
    if (typeof unwrapped.apply !== 'function') throw new Error('companion apply is missing');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: packageDir,
    encoding: 'utf8',
  })
  if (result.status === 0) continue
  const detail = result.error?.message
    ?? (result.stderr.trim() || result.stdout.trim() || `node exited ${result.status}`)
  failures.push(`${packageName}: ${detail}`)
}

if (failures.length > 0) {
  console.error('verify-built-package-invariants: compiled companion failures:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-built-package-invariants: ${manifests.length} compiled companion(s) passed plain-Node Loader checks.`)
