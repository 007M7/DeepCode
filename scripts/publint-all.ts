import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CONCURRENCY_ENV = 'DSH_PUBLINT_CONCURRENCY'

// Discover harness packages at packages/<group>/<pkg>; group containers,
// examples, and private vendored sources are not package targets.
const root = resolve(import.meta.dirname, '..')
const packagesRoot = resolve(root, 'packages')

type PublintResult =
  | { path: string; status: 'passed'; stdout: string; stderr: string }
  | { path: string; status: 'failed'; stdout: string; stderr: string; message: string }

function workspacePackages(): string[] {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(group => group.isDirectory())
    .flatMap(group =>
      readdirSync(resolve(packagesRoot, group.name), { withFileTypes: true })
        .filter(pkg => pkg.isDirectory())
        .filter(pkg => existsSync(resolve(packagesRoot, group.name, pkg.name, 'package.json')))
        .map(pkg => `packages/${group.name}/${pkg.name}`),
    )
}

function publintConcurrency(total: number): number {
  if (total === 0) return 0

  const raw = process.env[CONCURRENCY_ENV]
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`publint-all: ${CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
    }
    return Math.min(total, parsed)
  }

  return Math.min(total, availableParallelism())
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString()
  return ''
}

async function runPublint(path: string): Promise<PublintResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node_modules/.bin/publint', [path], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return { path, status: 'passed', stdout, stderr }
  } catch (error: unknown) {
    const failed = error as { stdout?: unknown; stderr?: unknown; message?: string }
    return {
      path,
      status: 'failed',
      stdout: outputText(failed.stdout),
      stderr: outputText(failed.stderr),
      message: failed.message ?? 'publint failed',
    }
  }
}

async function runAll(paths: string[], concurrency: number): Promise<PublintResult[]> {
  let next = 0
  const results: Array<PublintResult | undefined> = []
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next
      next += 1
      const path = paths[index]
      if (path === undefined) return
      results[index] = await runPublint(path)
    }
  }))

  return paths.map((path, index) => {
    const result = results[index]
    if (result === undefined) throw new Error(`publint-all: missing result for ${path}.`)
    return result
  })
}

function printResult(result: PublintResult): void {
  console.log(`Running publint for ${result.path}...`)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.status === 'failed') console.error(result.message)
}

const packages = workspacePackages()
const concurrency = publintConcurrency(packages.length)
console.log(`publint-all: linting ${packages.length} package(s) with ${concurrency} worker(s).`)

const results = await runAll(packages, concurrency)
for (const result of results) printResult(result)

if (results.some(result => result.status === 'failed')) process.exit(1)
