/** Verify every packed companion through its package self-reference under plain Node. */

import { execFile } from 'node:child_process'
import {
  copyFileSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CONCURRENCY_ENV = 'DSH_BUILT_INVARIANTS_CONCURRENCY'

const root = resolve(import.meta.dirname, '..')
const loaderUrl = pathToFileURL(resolve(root, 'vendor/loader/lib/index.js')).href
const manifests = globSync('packages/*/*/package.json', { cwd: root }).sort()
const packArgs = ['pack', '--dry-run', '--json', '--ignore-scripts']
// Windows cannot spawn npm's .cmd shim directly; setup-node installs this JS
// entrypoint beside node.exe, so the probe stays shell-free on every runner.
const npmInvocation = process.platform === 'win32'
  ? [process.execPath, [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...packArgs]]
  : ['npm', packArgs]

function probeConcurrency(total) {
  if (total === 0) return 0

  const raw = process.env[CONCURRENCY_ENV]
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
      throw new Error(`verify-built-package-invariants: ${CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
    }
    return Math.min(total, parsed)
  }

  return Math.min(total, availableParallelism())
}

async function runCommand(command, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return { status: 0, stdout, stderr, message: undefined }
  } catch (error) {
    const failed = /** @type {{ code?: number; stdout?: unknown; stderr?: unknown; message?: string }} */ (error)
    return {
      status: typeof failed.code === 'number' ? failed.code : 1,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
      message: failed.message ?? 'command failed',
    }
  }
}

/** Probe one manifest's packed companion; resolves to a failure string or undefined. */
async function verifyManifest(manifestPath) {
  const packageDir = dirname(resolve(root, manifestPath))
  const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'))
  const packageName = manifest.name
  if (typeof packageName !== 'string' || packageName.length === 0) {
    return `${manifestPath}: missing package name`
  }

  const pack = await runCommand(npmInvocation[0], npmInvocation[1], packageDir)
  if (pack.status !== 0) {
    const detail = pack.stderr.trim() || pack.stdout.trim() || pack.message
      || `npm pack exited ${pack.status}`
    return `${packageName}: ${detail}`
  }

  let files
  try {
    const result = JSON.parse(pack.stdout)
    files = result[0]?.files
    if (!Array.isArray(files)) throw new Error('npm pack returned no file inventory')
  } catch (error) {
    return `${packageName}: cannot parse npm pack inventory: ${String(error)}`
  }

  // Keep the packed view below its owning package so Node reaches the real
  // pnpm dependency links. Junctioning node_modules elsewhere breaks pnpm's
  // relative workspace links on Windows.
  const stagedPackageDir = mkdtempSync(resolve(packageDir, '.dsh-packed-invariant-'))
  try {
    for (const file of files) {
      if (typeof file.path !== 'string'
        || (file.path !== 'package.json' && !file.path.startsWith('lib/'))) continue
      const target = resolve(stagedPackageDir, file.path)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(resolve(packageDir, file.path), target)
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
    const result = await runCommand(process.execPath, ['--input-type=module', '--eval', probe], stagedPackageDir)
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || result.message
        || `node exited ${result.status}`
      return `${packageName}: ${detail}`
    }
    return undefined
  } finally {
    rmSync(stagedPackageDir, { recursive: true, force: true })
  }
}

/** Run every manifest probe through a bounded worker pool, keeping failures in manifest order. */
async function runAll(paths, concurrency) {
  let next = 0
  const results = new Array(paths.length)
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= paths.length) return
      results[index] = await verifyManifest(paths[index])
    }
  })
  await Promise.all(workers)
  return results.filter(failure => failure !== undefined)
}

const failures = await runAll(manifests, probeConcurrency(manifests.length))

if (failures.length > 0) {
  console.error('verify-built-package-invariants: packed companion failures:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-built-package-invariants: ${manifests.length} packed companion(s) passed plain-Node Loader checks.`)
