/**
 * Run local and CI quality gates with bounded in-process scheduling.
 *
 * The gate vocabulary stays in package.json; this runner only decides which
 * independent commands can overlap and which commands wait for built artifacts.
 */
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
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
  | 'manual-push'
  | 'doc-sync'
type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

interface Gate {
  id: string
  label: string
  displayCommand: string
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
  output: GateOutputChunk[]
  exitCode: number | null
  error?: string
}

interface GateOutputChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

interface RunningGate {
  gate: Gate
  promise: Promise<GateResult>
}

interface ConcurrencyDefault {
  workers: number
  source: string
}

const root = resolve(import.meta.dirname, '..')
const mode = parseMode(process.argv[2])
const gates = gatesForMode(mode)
const concurrencyDefault = defaultConcurrency(mode, gates.length)
const concurrencyOverride = process.env.DSH_GATE_CONCURRENCY
const maxConcurrency = concurrencyFromEnv('DSH_GATE_CONCURRENCY', concurrencyDefault.workers)
const verbose = process.env.DSH_GATE_VERBOSE === '1'
const startedAt = performance.now()

const concurrencySource = concurrencyOverride === undefined || concurrencyOverride === ''
  ? concurrencyDefault.source
  : '$DSH_GATE_CONCURRENCY'
console.log(`run-gates: ${mode} running ${gates.length} gate(s) with ${maxConcurrency} worker(s) from ${concurrencySource}.`)

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
    case 'doc-sync':
      return raw
    default:
      throw new Error(
        `run-gates: expected mode ci-primary | ci-static | ci-lint | ci-coverage | ci-snapshot | ci-artifacts | node-compat | pre-push | doc-sync, got ${JSON.stringify(raw)}.`,
      )
  }
}

function defaultConcurrency(selectedMode: Mode, total: number): ConcurrencyDefault {
  const available = availableParallelism()
  // Local modes cap workers: several doc gates each build a full ts.Program,
  // so an uncapped default on a large host trades wall clock for memory blowups.
  const localCap = selectedMode === 'pre-push' || selectedMode === 'doc-sync'
  const modeLimit = localCap ? Math.min(4, available) : available
  return {
    workers: Math.min(total, modeLimit),
    source: localCap
      ? `${available} available CPU(s), ${selectedMode} cap 4`
      : `${available} available CPU(s)`,
  }
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
    displayCommand: `pnpm run ${script}`,
    ...pnpmInvocation(['run', script]),
    ...options,
  }
}

function pnpmExec(id: string, args: string[], options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? `pnpm exec ${args.join(' ')}`,
    displayCommand: `pnpm exec ${args.join(' ')}`,
    ...pnpmInvocation(['exec', ...args]),
    ...options,
  }
}

function pnpmInvocation(args: string[]): Pick<Gate, 'command' | 'args'> {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('run-gates: npm_execpath is unavailable; invoke the runner through a pnpm package script.')
  }
  // Windows cannot spawn the pnpm.cmd shim directly; the JavaScript entrypoint keeps every host shell-free.
  return { command: process.execPath, args: [entrypoint, ...args] }
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
        pnpmScript('duplication', 'duplication'),
      ]
    case 'ci-coverage':
      return [
        pnpmScript('build', 'build'),
        coverageGate(),
      ]
    case 'ci-snapshot':
      return [
        pnpmScript('build', 'build'),
        snapshotGate(),
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
        pnpmExec('jsonl-zstd-smoke', [
          'vitest',
          'run',
          'packages/session-persistence/session-persistence-jsonl/tests/zstd.compat.spec.ts',
        ], { label: 'JSONL Zstandard smoke' }),
      ]
    case 'pre-push': return []
    case 'manual-push':
      return [
        pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
        pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
        pnpmScript('client-domain-graph', 'verify-client-domain-graph', { label: 'client domain graph' }),
        pnpmScript('test', 'test'),
        pnpmScript('duplication', 'duplication'),
        snapshotGate(),
        pnpmScript('build', 'build'),
        pnpmScript('build:web', 'build:web'),
        ...hygieneLeafGates({ artifactNeeds: ['build'] }),
        ...docSyncLeafGates({
          docTypecheckNeeds: ['build'],
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
        }),
        pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
      ]
    case 'doc-sync':
      return docSyncLeafGates()
  }
}

function ciPrimaryGates(): Gate[] {
  return [
    pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
    pnpmScript('typecheck', 'typecheck'),
    lintGate(),
    pnpmScript('duplication', 'duplication'),
    coverageGate(),
    snapshotGate(),
    ...docSyncLeafGates(),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    pnpmScript('knip', 'knip'),
    pnpmScript('build', 'build', { needs: ['typecheck'] }),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function ciStaticGates(): Gate[] {
  return [
    pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
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
    builtPackageInvariantsGate(['build']),
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
    env: { DSH_EXAMPLE_MODE: 'lib' },
    needs: ['build'],
  })
}

// The snapshot suite boots the example bins in `lib` mode (built artifact under plain Node,
// plugins via real exports) — CI and pre-push already build, so they exercise what ships rather
// than the tsx/source path dev uses. It therefore waits on `build`.
function snapshotGate(): Gate {
  return pnpmScript('snapshot', 'test:snapshot', {
    env: { DSH_EXAMPLE_MODE: 'lib' },
    needs: ['build'],
  })
}

function builtPackageInvariantsGate(needs?: string[]): Gate {
  return pnpmScript('built-package-invariants', 'verify-built-package-invariants', {
    label: 'built package invariants',
    ...needs === undefined ? {} : { needs },
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
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    builtPackageInvariantsGate(options.artifactNeeds),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      ...artifactOptions,
    }),
  ]
}

function docSyncLeafGates(options: {
  docTypecheckNeeds?: string[]
  docTypecheckEnv?: Record<string, string | undefined>
} = {}): Gate[] {
  const docTypecheckOptions: Partial<Gate> = {}
  if (options.docTypecheckNeeds !== undefined) docTypecheckOptions.needs = options.docTypecheckNeeds
  if (options.docTypecheckEnv !== undefined) docTypecheckOptions.env = options.docTypecheckEnv
  return [
    pnpmScript('doc-typecheck', 'doc-typecheck', docTypecheckOptions),
    pnpmScript('cordis-catalog', 'verify-cordis-catalog', { label: 'cordis catalog' }),
    pnpmScript('cordis-api', 'verify-cordis-api', { label: 'cordis api' }),
    pnpmScript('export-jsdoc', 'verify-export-jsdoc', { label: 'export jsdoc' }),
    pnpmScript('tool-catalog', 'verify-tool-catalog', { label: 'tool catalog' }),
    pnpmScript('config-catalog', 'verify-config-catalog', { label: 'config catalog' }),
    pnpmScript('persistence-catalog', 'verify-persistence-catalog', { label: 'persistence catalog' }),
    pnpmScript('doc-graphs', 'verify-doc-graphs', { label: 'doc graphs' }),
    pnpmScript('scoped-events', 'verify-scoped-events', { label: 'scoped events' }),
    pnpmScript('markdown-wrap', 'verify-md-wrap', { label: 'markdown wrap' }),
    pnpmScript('markdown-links', 'verify-md-links', { label: 'markdown links' }),
    pnpmScript('doc-refs', 'verify-doc-refs', { label: 'doc refs' }),
    pnpmScript('package-paths', 'verify-package-paths', { label: 'package paths' }),
    pnpmScript('package-readme-model-experience', 'verify-package-readme-model-experience', { label: 'package README model experience' }),
    pnpmScript('mermaid', 'verify-mermaid'),
    pnpmScript('agent-note-classification', 'verify-agent-note-classification', { label: 'agent note classification' }),
    pnpmScript('agent-note-format', 'verify-agent-note-format', { label: 'agent note format' }),
    pnpmScript('type-equivalence', 'verify-type-equiv', { label: 'type equivalence' }),
    pnpmScript('translation-prompt', 'verify-translation-prompt', { label: 'translation prompt' }),
    pnpmScript('translation-pairing', 'verify-translation-pairing', { label: 'translation pairing' }),
    pnpmScript('doc-budgets', 'verify-doc-budgets', { label: 'doc budgets' }),
    // Keep the VitePress build in this single gate because projection rewrites website/.generated.
    pnpmScript('docs-site', 'docs:check', { label: 'documentation site' }),
    pnpmScript('package-readme-limitations', 'verify-package-readme-limitations', { label: 'package README limitations' }),
  ]
}

function builtBinSmokeGate(): Gate {
  return pnpmExec('built-bin-smoke', [
    'vitest',
    'run',
    '--config',
    'vitest.e2e.config.ts',
    'examples/headless-agent/tests/keyless-smoke.e2e.ts',
    'examples/tui-agent/tests/tui-keyless-smoke.e2e.ts',
    'packages/examples/cli-demo/tests/built-bin.e2e.ts',
    'packages/examples/acp-demo/tests/built-bin.e2e.ts',
    'packages/ui/jsonrpc/tests/built-scope-carrier.e2e.ts',
    // The worker-entry packages' built bundles: the only automated proof
    // that lib/index.js resolves its sibling lib/worker.cjs under plain node
    // (the e2e lane runs unbuilt, so these files self-skip there).
    'packages/workflow/workflow-workerthread/tests/built-worker.e2e.ts',
    'packages/code-runtime/code-runtime-worker/tests/built-lib.e2e.ts',
  ], {
    label: 'built-bin smoke',
    needs: ['build'],
    env: { DSH_EXAMPLE_MODE: 'lib' },
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
          output: [],
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
  const output: GateOutputChunk[] = []
  let spawnError: string | undefined

  const exitCode = await new Promise<number | null>((resolveExit) => {
    const child = spawn(gate.command, gate.args, {
      cwd: root,
      env: { ...process.env, ...gate.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      output.push({ stream: 'stdout', text: chunk })
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      output.push({ stream: 'stderr', text: chunk })
    })
    child.on('error', (error) => {
      spawnError = `failed to start command: ${error.message}`
      resolveExit(null)
    })
    child.on('close', resolveExit)
    if (gate.input !== undefined) child.stdin.end(gate.input)
    else child.stdin.end()
  })

  let status: GateStatus = exitCode === 0 && spawnError === undefined ? 'passed' : 'failed'
  let error = spawnError
  if (status === 'passed' && gate.verify !== undefined) {
    try {
      await gate.verify({ gate, status, durationMs: performance.now() - started, stdout, stderr, output, exitCode })
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
    output,
    exitCode,
  }
  if (error !== undefined) result.error = error
  return result
}

function printResult(result: GateResult): void {
  const seconds = (result.durationMs / 1000).toFixed(2)
  if (result.status === 'passed' && !verbose) {
    console.log(`run-gates: PASS ${result.gate.label} (${seconds}s)`)
    return
  }

  const heading = `${result.status.toUpperCase()} ${result.gate.label} (${seconds}s)`
  const writeHeading = result.status === 'passed' ? console.log : console.error
  writeHeading(`\n== ${heading} ==`)
  if (result.status !== 'passed') console.error(`command: ${result.gate.displayCommand}`)
  printOutput(result.output)
  if (result.error !== undefined) console.error(result.error)
}

function printSummary(results: GateResult[], durationMs: number): void {
  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const seconds = (durationMs / 1000).toFixed(2)
  console.log(`\nrun-gates: ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s.`)

  const unsuccessful = results.filter(result => result.status === 'failed' || result.status === 'skipped')
  if (unsuccessful.length === 0) return

  console.error('run-gates: unsuccessful gates:')
  for (const result of unsuccessful) {
    const duration = (result.durationMs / 1000).toFixed(2)
    const reason = result.error ?? (result.exitCode === null ? 'no exit code' : `exit ${result.exitCode}`)
    console.error(`  - ${result.status.toUpperCase()} ${result.gate.label} (${duration}s, ${reason})`)
    console.error(`    ${result.gate.displayCommand}`)
  }
}

function printOutput(output: GateOutputChunk[]): void {
  for (const chunk of output) {
    if (chunk.stream === 'stdout') process.stdout.write(chunk.text)
    else process.stderr.write(chunk.text)
  }
}
