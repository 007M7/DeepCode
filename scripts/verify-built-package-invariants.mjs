/** Verify every packed companion through its package self-reference under plain Node. */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const loaderUrl = pathToFileURL(resolve(root, 'vendor/loader/lib/index.js')).href
const failures = []
const manifests = globSync('packages/*/*/package.json', { cwd: root }).sort()
const stagingRoot = mkdtempSync(resolve(tmpdir(), 'dsh-built-package-invariants-'))

try {
  for (const [index, manifestPath] of manifests.entries()) {
    const packageDir = dirname(resolve(root, manifestPath))
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'))
    const packageName = manifest.name
    if (typeof packageName !== 'string' || packageName.length === 0) {
      failures.push(`${manifestPath}: missing package name`)
      continue
    }

    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageDir,
      encoding: 'utf8',
    })
    if (pack.status !== 0) {
      const detail = pack.error?.message
        ?? (pack.stderr.trim() || pack.stdout.trim() || `npm pack exited ${pack.status}`)
      failures.push(`${packageName}: ${detail}`)
      continue
    }

    let files
    try {
      const result = JSON.parse(pack.stdout)
      files = result[0]?.files
      if (!Array.isArray(files)) throw new Error('npm pack returned no file inventory')
    } catch (error) {
      failures.push(`${packageName}: cannot parse npm pack inventory: ${String(error)}`)
      continue
    }

    const stagedPackageDir = resolve(stagingRoot, String(index))
    for (const file of files) {
      if (typeof file.path !== 'string'
        || (file.path !== 'package.json' && !file.path.startsWith('lib/'))) continue
      const target = resolve(stagedPackageDir, file.path)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(resolve(packageDir, file.path), target)
    }
    const packageNodeModules = resolve(packageDir, 'node_modules')
    if (existsSync(packageNodeModules)) {
      symlinkSync(packageNodeModules, resolve(stagedPackageDir, 'node_modules'), 'dir')
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
      cwd: stagedPackageDir,
      encoding: 'utf8',
    })
    if (result.status === 0) continue
    const detail = result.error?.message
      ?? (result.stderr.trim() || result.stdout.trim() || `node exited ${result.status}`)
    failures.push(`${packageName}: ${detail}`)
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('verify-built-package-invariants: packed companion failures:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-built-package-invariants: ${manifests.length} packed companion(s) passed plain-Node Loader checks.`)
