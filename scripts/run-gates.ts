/**
 * Run local and CI quality gates with bounded in-process scheduling.
 *
 * The gate vocabulary stays in package.json; this runner only decides which
 * independent commands can overlap and which commands wait for built artifacts.
 */
import { spawn } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

type Mode =
  | 'ci-primary'
  | 'ci-static'
  | 'ci-lint'
  | 'ci-coverage'
  | 'ci-snapshot'
  | 'ci-artifacts'
  | 'node-compat'
  | 'pre-push'
type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

interface Gate {
  id: string
  label: string
  command: string
  args: string[]
  needs?: string[]
  env?: Record<string, string | undefined>
  input?: string
  verify?: (result: GateResult) => Promise<void>
}

interface GateResult {
  gate: Gate
  status: GateStatus
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

interface RunningGate {
  gate: Gate
  promise: Promise<GateResult>
}

const root = resolve(import.meta.dirname, '..')
const mode = parseMode(process.argv[2])
const gates = gatesForMode(mode)
const maxConcurrency = concurrencyFromEnv('DSH_GATE_CONCURRENCY', defaultConcurrency(gates.length))
const startedAt = performance.now()

console.log(`run-gates: ${mode} running ${gates.length} gate(s) with ${maxConcurrency} worker(s).`)

const results = await runGates(gates, maxConcurrency)
printSummary(results, performance.now() - startedAt)

if (results.some(result => result.status === 'failed' || result.status === 'skipped')) process.exit(1)

function parseMode(raw: string | undefined): Mode {
  switch (raw) {
    case 'ci-primary':
    case 'ci-static':
    case 'ci-lint':
    case 'ci-coverage':
    case 'ci-snapshot':
    case 'ci-artifacts':
    case 'node-compat':
    case 'pre-push':
      return raw
    default:
      throw new Error(
        `run-gates: expected mode ci-primary | ci-static | ci-lint | ci-coverage | ci-snapshot | ci-artifacts | node-compat | pre-push, got ${JSON.stringify(raw)}.`,
      )
  }
}

function defaultConcurrency(total: number): number {
  return Math.min(total, Math.max(4, availableParallelism()))
}

function concurrencyFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`run-gates: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

function pnpmScript(id: string, script: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? script,
    command: pnpmBin(),
    args: ['run', script],
    ...options,
  }
}

function pnpmExec(id: string, args: string[], options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? `pnpm exec ${args.join(' ')}`,
    command: pnpmBin(),
    args: ['exec', ...args],
    ...options,
  }
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function nodeOptions(...options: string[]): string {
  return [process.env.NODE_OPTIONS, ...options].filter(option => option !== undefined && option !== '').join(' ')
}

function gatesForMode(selected: Mode): Gate[] {
  switch (selected) {
    case 'ci-primary':
      return ciPrimaryGates()
    case 'ci-static':
      return ciStaticGates()
    case 'ci-lint':
      return [
        lintGate(),
      ]
    case 'ci-coverage':
      return [
        coverageGate(),
      ]
    case 'ci-snapshot':
      return [
        pnpmScript('snapshot', 'test:snapshot'),
      ]
    case 'ci-artifacts':
      return ciArtifactGates()
    case 'node-compat':
      return [
        pnpmScript('typecheck', 'typecheck'),
        pnpmExec('source-worker-smoke', [
          'vitest',
          'run',
          'packages/workflow/workflow-workerthread/tests/source-worker.compat.spec.ts',
        ], { label: 'source worker smoke' }),
      ]
    case 'pre-push':
      return [
        pnpmScript('test', 'test'),
        pnpmScript('snapshot', 'test:snapshot'),
        pnpmScript('build', 'build'),
        ...hygieneLeafGates({ artifactNeeds: ['build'] }),
        ...docSyncLeafGates(),
        pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
      ]
  }
}

function ciPrimaryGates(): Gate[] {
  return [
    pnpmScript('constraints', 'constraints'),
    pnpmScript('typecheck', 'typecheck'),
    lintGate(),
    coverageGate(),
    pnpmScript('snapshot', 'test:snapshot'),
    demoSmokeGate({ needs: ['lint'] }),
    ...docSyncLeafGates(),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    pnpmScript('knip', 'knip'),
    pnpmScript('build', 'build', { needs: ['typecheck'] }),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtBinSmokeGate(),
  ]
}

function ciStaticGates(): Gate[] {
  return [
    pnpmScript('constraints', 'constraints'),
    demoSmokeGate(),
    ...docSyncLeafGates(),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    pnpmScript('knip', 'knip'),
  ]
}

function ciArtifactGates(): Gate[] {
  return [
    pnpmScript('build', 'build'),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtBinSmokeGate(),
  ]
}

function lintGate(): Gate {
  if (process.env.DSH_ESLINT_CACHE === '1') {
    return pnpmExec('lint', [
      'eslint',
      '.',
      '--cache',
      '--cache-location',
      '.cache/eslint/',
      '--cache-strategy',
      'content',
    ], {
      label: 'lint',
      env: { NODE_OPTIONS: nodeOptions('--max-old-space-size=8192') },
    })
  }
  return pnpmScript('lint', 'lint', {
    env: { NODE_OPTIONS: nodeOptions('--max-old-space-size=8192') },
  })
}

function coverageGate(): Gate {
  return pnpmExec('coverage', [
    'vitest',
    'run',
    '--coverage',
    ...positiveIntArg('DSH_COVERAGE_MAX_WORKERS', '--maxWorkers'),
  ], {
    label: 'test:coverage',
  })
}

function positiveIntArg(envName: string, flag: string): string[] {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return []
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`run-gates: ${envName} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return [`${flag}=${raw}`]
}

function hygieneLeafGates(options: { artifactNeeds?: string[] } = {}): Gate[] {
  const artifactOptions = options.artifactNeeds === undefined ? {} : { needs: options.artifactNeeds }
  return [
    pnpmScript('knip', 'knip'),
    pnpmScript('publint', 'publint', artifactOptions),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      ...artifactOptions,
    }),
  ]
}

function docSyncLeafGates(): Gate[] {
  return [
    pnpmScript('doc-typecheck', 'doc-typecheck'),
    pnpmScript('cordis-catalog', 'verify-cordis-catalog', { label: 'cordis catalog' }),
    pnpmScript('export-jsdoc', 'verify-export-jsdoc', { label: 'export jsdoc' }),
    pnpmScript('tool-catalog', 'verify-tool-catalog', { label: 'tool catalog' }),
    pnpmScript('config-catalog', 'verify-config-catalog', { label: 'config catalog' }),
    pnpmScript('persistence-catalog', 'verify-persistence-catalog', { label: 'persistence catalog' }),
    pnpmScript('doc-graphs', 'verify-doc-graphs', { label: 'doc graphs' }),
    pnpmScript('scoped-dispatch', 'verify-scoped-dispatch', { label: 'scoped dispatch' }),
    pnpmScript('markdown-wrap', 'verify-md-wrap', { label: 'markdown wrap' }),
    pnpmScript('markdown-links', 'verify-md-links', { label: 'markdown links' }),
    pnpmScript('doc-refs', 'verify-doc-refs', { label: 'doc refs' }),
    pnpmScript('package-paths', 'verify-package-paths', { label: 'package paths' }),
    pnpmScript('mermaid', 'verify-mermaid'),
    pnpmScript('rfc-classification', 'verify-rfc-classification', { label: 'rfc classification' }),
    pnpmScript('rfc-format', 'verify-rfc-format', { label: 'rfc format' }),
    pnpmScript('type-equivalence', 'verify-type-equiv', { label: 'type equivalence' }),
    pnpmScript('translation-pairing', 'verify-translation-pairing', { label: 'translation pairing' }),
    pnpmScript('doc-budgets', 'verify-doc-budgets', { label: 'doc budgets' }),
  ]
}

function demoSmokeGate(options: { needs?: string[] } = {}): Gate {
  const dependencyOptions = options.needs === undefined ? {} : { needs: options.needs }
  return {
    id: 'demo-smoke',
    label: 'demo smoke',
    command: pnpmBin(),
    args: ['run', 'demo:echo'],
    input: 'echo ci smoke\n',
    ...dependencyOptions,
    verify: async (result) => {
      const output = result.stdout + result.stderr
      const sessionsRoot = join(root, '.sessions')
      try {
        if (!output.includes('[tool call] echo({"text":"ci smoke"})')) {
          throw new Error('demo smoke did not show the echo tool call.')
        }
        if (!output.includes('[tool result] ECHO: CI SMOKE')) {
          throw new Error('demo smoke did not show the echo tool result.')
        }
        const buckets = await readdir(sessionsRoot, { withFileTypes: true })
        let found = false
        for (const bucket of buckets) {
          if (!bucket.isDirectory() || !bucket.name.startsWith('cwd-')) continue
          const entries = await readdir(join(sessionsRoot, bucket.name))
          if (entries.some(entry => /^main-session-.+\.jsonl$/.test(entry))) {
            found = true
            break
          }
        }
        if (!found) throw new Error('demo smoke did not create a main-session JSONL log in a cwd bucket.')
      } finally {
        await rm(sessionsRoot, { recursive: true, force: true })
      }
    },
  }
}

function builtBinSmokeGate(): Gate {
  return pnpmExec('built-bin-smoke', [
    'vitest',
    'run',
    '--config',
    'vitest.e2e.config.ts',
    'packages/ui/stdio-agent/tests/built-bin.e2e.ts',
    'packages/ui/acp-agent/tests/built-bin.e2e.ts',
    // The worker-entry packages' built bundles: the only automated proof
    // that lib/index.js resolves its sibling lib/worker.js under plain node
    // (the e2e lane runs unbuilt, so these files self-skip there).
    'packages/workflow/workflow-workerthread/tests/built-worker.e2e.ts',
    'packages/code-runtime/code-runtime-worker/tests/built-lib.e2e.ts',
  ], {
    label: 'built-bin smoke',
    needs: ['build'],
  })
}

async function runGates(allGates: Gate[], maxActive: number): Promise<GateResult[]> {
  const states = new Map<string, GateStatus>(allGates.map(gate => [gate.id, 'pending']))
  const results = new Map<string, GateResult>()
  const running: RunningGate[] = []

  for (;;) {
    let madeProgress = false
    while (running.length < maxActive) {
      const ready = allGates.find(gate => states.get(gate.id) === 'pending' && dependenciesPassed(gate, states))
      if (ready === undefined) break
      states.set(ready.id, 'running')
      running.push({ gate: ready, promise: runGate(ready) })
      console.log(`run-gates: start ${ready.label}`)
      madeProgress = true
    }

    if (running.length === 0) {
      const pending = allGates.filter(gate => states.get(gate.id) === 'pending')
      for (const gate of pending) {
        const failedDeps = (gate.needs ?? []).filter(id => states.get(id) !== 'passed')
        const result: GateResult = {
          gate,
          status: 'skipped',
          durationMs: 0,
          stdout: '',
          stderr: '',
          exitCode: null,
          error: `dependency failed or skipped: ${failedDeps.join(', ')}`,
        }
        states.set(gate.id, 'skipped')
        results.set(gate.id, result)
        printResult(result)
      }
      break
    }

    if (!madeProgress) {
      const settled = await Promise.race(running.map(async item => ({ item, result: await item.promise })))
      running.splice(running.indexOf(settled.item), 1)
      states.set(settled.item.gate.id, settled.result.status)
      results.set(settled.item.gate.id, settled.result)
      printResult(settled.result)
    }
  }

  return allGates.map((gate) => {
    const result = results.get(gate.id)
    if (result === undefined) throw new Error(`run-gates: missing result for ${gate.id}.`)
    return result
  })
}

function dependenciesPassed(gate: Gate, states: Map<string, GateStatus>): boolean {
  return (gate.needs ?? []).every(id => states.get(id) === 'passed')
}

async function runGate(gate: Gate): Promise<GateResult> {
  const started = performance.now()
  let stdout = ''
  let stderr = ''

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(gate.command, gate.args, {
      cwd: root,
      env: { ...process.env, ...gate.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', resolveExit)
    if (gate.input !== undefined) child.stdin.end(gate.input)
    else child.stdin.end()
  })

  let status: GateStatus = exitCode === 0 ? 'passed' : 'failed'
  let error: string | undefined
  if (status === 'passed' && gate.verify !== undefined) {
    try {
      await gate.verify({ gate, status, durationMs: performance.now() - started, stdout, stderr, exitCode })
    } catch (verifyError: unknown) {
      status = 'failed'
      error = verifyError instanceof Error ? verifyError.message : String(verifyError)
    }
  }

  const result: GateResult = {
    gate,
    status,
    durationMs: performance.now() - started,
    stdout,
    stderr,
    exitCode,
  }
  if (error !== undefined) result.error = error
  return result
}

function printResult(result: GateResult): void {
  const seconds = (result.durationMs / 1000).toFixed(2)
  console.log(`\n== ${result.status.toUpperCase()} ${result.gate.label} (${seconds}s) ==`)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.error !== undefined) console.error(result.error)
}

function printSummary(results: GateResult[], durationMs: number): void {
  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const seconds = (durationMs / 1000).toFixed(2)
  console.log(`\nrun-gates: ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s.`)
}
