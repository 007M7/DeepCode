/**
 * Construct, inspect, and run local and CI quality-gate plans with bounded scheduling.
 *
 * Package scripts own public aggregate names; this runner owns their validated
 * dependency graphs, scheduler environment, replay diagnostics, and private logs.
 * @see ../.agents/notes/implemented/process/2026-07-27-replayable-gate-plans.md
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const MODES = [
  'ci-primary',
  'ci-static',
  'ci-lint',
  'ci-coverage',
  'ci-snapshot',
  'ci-artifacts',
  'ci-consumers',
  'ci-windows-blocking',
  'ci-windows-complete',
  'ci-windows-observational',
  'node-compat',
  'check-all',
  'doc-sync',
] as const

/** A named aggregate exposed by the gate runner. */
export type Mode = typeof MODES[number]

type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

/** One scheduler-owned environment operation, resolved against inherited values only at spawn time. */
export type GateEnvironmentOverride =
  | { operation: 'set'; value: string }
  | { operation: 'unset' }
  | { operation: 'append'; value: string; separator?: string }

/** A command and its dependency metadata inside one gate plan. */
export interface Gate {
  id: string
  label: string
  displayCommand: string
  command: string
  args: string[]
  needs?: string[]
  env?: Record<string, GateEnvironmentOverride>
  input?: string
  verify?: (result: GateResult) => Promise<void>
  allowFailure?: boolean
}

/** A complete executable aggregate and the package script that owns its diagnostics. */
export interface GatePlan {
  mode: Mode
  script: string
  gates: Gate[]
  maxWorkers?: number
}

/** The observed outcome of one gate process. */
export interface GateResult {
  gate: Gate
  status: GateStatus
  durationMs: number
  stdout: string
  stderr: string
  output: GateOutputChunk[]
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  error?: string
  logPath?: string
  logError?: string
}

interface GateOutputChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

interface RunningGate {
  gate: Gate
  promise: Promise<GateResult>
}

/** The effective worker count and the facts that selected it. */
export interface ResolvedConcurrency {
  workers: number
  source: string
}

interface RunRequest {
  kind: 'run'
  mode: Mode
  list: boolean
  json: boolean
  only?: string
}

interface CleanLogsRequest {
  kind: 'clean-logs'
}

type CliRequest = RunRequest | CleanLogsRequest

interface ListedEnvironmentOverride {
  operation: GateEnvironmentOverride['operation']
  value?: string
  separator?: string
}

interface ListedGate {
  id: string
  label: string
  command: string
  needs: string[]
  env: Record<string, ListedEnvironmentOverride>
  blocking: boolean
}

interface ListedPlan {
  version: 1
  mode: Mode
  script: string
  scope: 'complete'
  maxWorkers: number | null
  gates: ListedGate[]
}

interface GateLogDirectoryIdentity {
  dev: string
  ino: string
}

type GateLogHelperRequest =
  | { operation: 'write'; filename: string; content: string; retention: number }
  | { operation: 'prune'; retain: number }
  | { operation: 'clean' }

interface GateLogHelperResult {
  directory?: GateLogDirectoryIdentity
  filename?: string
  removed: string[]
}

type GateExecutor = (gate: Gate) => Promise<GateResult>
type ResultObserver = (result: GateResult) => Promise<void> | void

const root = resolve(import.meta.dirname, '..')
const gateLogRoot = resolve(root, '.cache/gates')
const gateLogHelper = resolve(import.meta.dirname, 'gate-log-helper.mjs')
const GATE_LOG_RETENTION = 20
const GATE_LOG_MAX_BYTES = 1_048_576
const MIN_GATE_LOG_MAX_BYTES = 128
const MODE_SCRIPTS: Record<Mode, string> = {
  'ci-primary': 'check:ci',
  'ci-static': 'check:ci:static',
  'ci-lint': 'check:ci:lint',
  'ci-coverage': 'check:ci:coverage',
  'ci-snapshot': 'check:ci:snapshot',
  'ci-artifacts': 'check:ci:artifacts',
  'ci-consumers': 'check:ci:consumers',
  'ci-windows-blocking': 'check:ci:windows-blocking',
  'ci-windows-complete': 'check:ci:windows-complete',
  'ci-windows-observational': 'check:ci:windows-observational',
  'node-compat': 'check:node-compat',
  'check-all': 'check:all',
  'doc-sync': 'doc-sync',
}

if (isMainModule()) process.exitCode = await main(process.argv.slice(2))

async function main(args: string[]): Promise<number> {
  const request = parseCliRequest(args)
  if (request.kind === 'clean-logs') {
    await cleanGateFailureLogs()
    console.log('run-gates: cleared retained logs in .cache/gates/.')
    return 0
  }

  const completePlan = gatePlanForMode(request.mode)
  validateGatePlan(completePlan)
  if (request.list) {
    console.log(request.json ? formatGatePlanJson(completePlan) : formatGatePlanList(completePlan))
    return 0
  }

  const plan = request.only === undefined
    ? completePlan
    : { ...completePlan, gates: gateDependencyClosure(completePlan, request.only) }
  validateGatePlan(plan)
  if (request.only !== undefined) console.log(formatOnlyNotice(completePlan, request.only))

  const concurrency = resolvePlanConcurrency(plan, process.env.DSH_GATE_CONCURRENCY)
  const maxConcurrency = concurrency.workers
  const concurrencySource = concurrency.source
  const startedAt = performance.now()
  console.log(`run-gates: ${request.mode} running ${plan.gates.length} gate(s) with ${maxConcurrency} worker(s) from ${concurrencySource}.`)

  const results = await executeGatePlan(plan, maxConcurrency, runGate, async (result) => {
    await attachFailureLog(completePlan, result)
    printResult(completePlan, result)
  })
  printSummary(completePlan, results, performance.now() - startedAt)
  return results.some(result => result.gate.allowFailure !== true && (result.status === 'failed' || result.status === 'skipped'))
    ? 1
    : 0
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

/**
 * Parse one runner invocation without constructing or starting its plan.
 * @param args - command-line arguments after the script entrypoint.
 * @returns the validated run or cleanup request.
 */
export function parseCliRequest(args: readonly string[]): CliRequest {
  if (args[0] === '--clean-logs') {
    if (args.length !== 1) throw new Error('run-gates: --clean-logs does not accept other arguments.')
    return { kind: 'clean-logs' }
  }

  const mode = parseMode(args[0])
  let list = false
  let json = false
  let only: string | undefined
  const firstOption = args[1] === '--' ? 2 : 1
  for (let index = firstOption; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--list') {
      if (list) throw new Error('run-gates: --list may be specified only once.')
      list = true
    } else if (arg === '--json') {
      if (json) throw new Error('run-gates: --json may be specified only once.')
      json = true
    } else if (arg === '--only') {
      if (only !== undefined) throw new Error('run-gates: --only may be specified only once.')
      const id = args[index + 1]
      if (id === undefined || id.startsWith('--')) throw new Error('run-gates: --only requires a gate id.')
      only = id
      index += 1
    } else {
      throw new Error(`run-gates: unsupported argument ${JSON.stringify(arg)}.`)
    }
  }
  if (json && !list) throw new Error('run-gates: --json requires --list.')
  if (list && only !== undefined) throw new Error('run-gates: --list and --only are mutually exclusive.')
  return { kind: 'run', mode, list, json, ...only === undefined ? {} : { only } }
}

function parseMode(raw: string | undefined): Mode {
  if (MODES.includes(raw as Mode)) return raw as Mode
  throw new Error(`run-gates: expected mode ${MODES.join(' | ')}, got ${JSON.stringify(raw)}.`)
}

function defaultConcurrency(plan: GatePlan, available: number): ResolvedConcurrency {
  if (plan.maxWorkers !== undefined) {
    return {
      workers: Math.min(plan.gates.length, plan.maxWorkers),
      source: `${plan.mode} plan default ${plan.maxWorkers}`,
    }
  }
  // Local modes cap workers: several doc gates each build a full ts.Program,
  // so an uncapped default on a large host trades wall clock for memory blowups.
  const localCap = plan.mode === 'check-all' || plan.mode === 'doc-sync'
  const modeLimit = localCap ? Math.min(4, available) : available
  return {
    workers: Math.min(plan.gates.length, modeLimit),
    source: localCap
      ? `${available} available CPU(s), ${plan.mode} cap 4`
      : `${available} available CPU(s)`,
  }
}

function concurrencyFromValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`run-gates: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

/**
 * Resolve a plan's default, optional environment request, and hard worker ceiling.
 * @param plan - validated complete or diagnostic plan.
 * @param override - optional `DSH_GATE_CONCURRENCY` value.
 * @param available - host CPU availability for modes without a plan-owned default.
 * @returns the effective worker count and its inspectable source.
 */
export function resolvePlanConcurrency(
  plan: GatePlan,
  override: string | undefined,
  available = availableParallelism(),
): ResolvedConcurrency {
  validateGatePlan(plan)
  const defaultValue = defaultConcurrency(plan, available)
  const requested = concurrencyFromValue('DSH_GATE_CONCURRENCY', override, defaultValue.workers)
  const workers = Math.min(requested, plan.maxWorkers ?? requested)
  const requestedSource = override === undefined || override === ''
    ? defaultValue.source
    : '$DSH_GATE_CONCURRENCY'
  return {
    workers,
    source: workers === requested
      ? requestedSource
      : `${requestedSource}, ${plan.mode} plan cap ${String(plan.maxWorkers)}`,
  }
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

/**
 * Construct the complete plan for a named aggregate without executing it.
 * @param selected - aggregate mode to construct.
 * @returns the aggregate's package-script identity and gate graph.
 */
export function gatePlanForMode(selected: Mode): GatePlan {
  return {
    mode: selected,
    script: MODE_SCRIPTS[selected],
    gates: gatesForMode(selected),
    ...selected === 'ci-consumers' ? { maxWorkers: 7 } : {},
  }
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
      return [coverageGate()]
    case 'ci-snapshot':
      return [pnpmScript('build', 'build'), snapshotGate()]
    case 'ci-artifacts':
      return ciArtifactGates()
    case 'ci-consumers':
      return ciConsumerGates()
    case 'ci-windows-blocking':
      return ciWindowsBlockingGates()
    case 'ci-windows-complete':
      return ciWindowsCompleteGates()
    case 'ci-windows-observational':
      return ciWindowsObservationalGates()
    case 'node-compat':
      return nodeCompatGates()
    case 'check-all':
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
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: { operation: 'set', value: '1' } },
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
    ...nodeCompatSmokeGates(),
    snapshotGate(),
    ...docSyncLeafGates(),
    pnpmScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    pnpmScript('knip', 'knip'),
    // typecheck and build now drive the same root solution graph; without the
    // dependency two concurrent `tsc -b` runs race the same tsbuildinfo files.
    // The tsc step is an incremental no-op after typecheck.
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

function nodeCompatGates(): Gate[] {
  return [
    ...flagEnabled('DSH_NODE_COMPAT_SKIP_TYPECHECK') ? [] : [pnpmScript('typecheck', 'typecheck')],
    ...nodeCompatSmokeGates(),
  ]
}

function nodeCompatSmokeGates(): Gate[] {
  return [
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
}

function ciStaticGates(): Gate[] {
  return [
    pnpmScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
    pnpmScript('constraints', 'constraints'),
    pnpmScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    pnpmScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
    pnpmScript('build', 'build'),
    ...docSyncLeafGates({
      docTypecheckNeeds: ['build'],
      docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: { operation: 'set', value: '1' } },
      docsBuildScript: 'docs:build:mpa',
    }),
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

function ciConsumerGates(): Gate[] {
  const publicArtifacts = ['publint']
  const restoredBuild = ['built-package-invariants']
  return [
    pnpmScript('lint-and-duplication', 'check:ci:lint', { label: 'lint and duplication' }),
    pnpmScript('node-compat', 'check:node-compat', { label: 'Node compatibility' }),
    snapshotGate(restoredBuild),
    pnpmScript('publint', 'publint'),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: restoredBuild,
    }),
    builtPackageInvariantsGate(publicArtifacts),
    builtBinSmokeGate(restoredBuild),
  ]
}

function ciWindowsBlockingGates(): Gate[] {
  return [
    pnpmScript('windows-build', 'build', { label: 'build' }),
    pnpmScript('windows-site', 'docs:build', { label: 'production site' }),
  ]
}

function ciWindowsCompleteGates(): Gate[] {
  const observational = ciWindowsObservationalGates()
    // The required production site replaces the observational MPA build; both
    // VitePress modes write the same output directory and cannot overlap.
    .filter(gate => gate.id !== 'build' && gate.id !== 'docs-site-build')
    .map(gate => ({ ...gate, allowFailure: true }))
  return [
    pnpmScript('build', 'build'),
    pnpmScript('windows-site', 'docs:build', { label: 'production site' }),
    ...observational,
  ]
}

function ciWindowsObservationalGates(): Gate[] {
  return [
    ...ciStaticGates(),
    // Linux owns required lint, coverage, and snapshots; Windows omits those duplicates.
    pnpmScript('duplication', 'duplication'),
    pnpmScript('publint', 'publint', { needs: ['build'] }),
    pnpmScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function lintGate(eslintTargets: readonly string[] = ['.']): Gate {
  const concurrencyArgs = eslintConcurrencyArgs()
  if (process.env.DSH_ESLINT_CACHE === '1') {
    return pnpmExec('lint', [
      'eslint',
      ...eslintTargets,
      ...concurrencyArgs,
      '--cache',
      '--cache-location',
      '.cache/eslint/',
      '--cache-strategy',
      'content',
    ], {
      label: 'lint',
      env: { NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' } },
    })
  }
  if (concurrencyArgs.length > 0) {
    return pnpmExec('lint', ['eslint', ...eslintTargets, ...concurrencyArgs], {
      label: 'lint',
      env: { NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' } },
    })
  }
  return pnpmScript('lint', 'lint', {
    env: { NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' } },
  })
}

function eslintConcurrencyArgs(): string[] {
  const raw = process.env.DSH_ESLINT_CONCURRENCY
  if (raw === undefined || raw === '') return []
  if (raw === 'auto') return ['--concurrency=auto']
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`run-gates: DSH_ESLINT_CONCURRENCY must be a positive integer or auto, got ${JSON.stringify(raw)}.`)
  }
  return [`--concurrency=${raw}`]
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

// Example and package snapshots boot their bins in `lib` mode (built artifacts under plain Node,
// plugins via real exports); repository-script snapshots execute their real source entry path.
// Build-owning modes wait on `build`; a restored-artifact mode passes its validation dependency.
function snapshotGate(needs: string[] = ['build']): Gate {
  return pnpmScript('snapshot', 'test:snapshot', {
    env: { DSH_EXAMPLE_MODE: { operation: 'set', value: 'lib' } },
    needs,
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

function flagEnabled(envName: string): boolean {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return false
  if (raw !== '1') throw new Error(`run-gates: ${envName} must be 1 when set, got ${JSON.stringify(raw)}.`)
  return true
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
  docTypecheckEnv?: Record<string, GateEnvironmentOverride>
  docsBuildScript?: 'docs:build' | 'docs:build:mpa'
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
    pnpmScript('archived-agent-notes', 'verify-archived-agent-notes', { label: 'archived agent notes' }),
    pnpmScript('type-equivalence', 'verify-type-equiv', { label: 'type equivalence' }),
    pnpmScript('translation-prompt', 'verify-translation-prompt', { label: 'translation prompt' }),
    pnpmScript('translation-pairing', 'verify-translation-pairing', { label: 'translation pairing' }),
    pnpmScript('doc-budgets', 'verify-doc-budgets', { label: 'doc budgets' }),
    pnpmExec('docs-site-projection', ['vitest', 'run', 'scripts/project-doc-site.spec.ts'], {
      label: 'documentation projection',
    }),
    // Keep the VitePress build itself in one gate because projection rewrites website/.generated.
    pnpmScript('docs-site-build', options.docsBuildScript ?? 'docs:build', { label: 'documentation build' }),
    pnpmScript('package-readme-limitations', 'verify-package-readme-limitations', { label: 'package README limitations' }),
  ]
}

function builtBinSmokeGate(needs: string[] = ['build']): Gate {
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
    needs,
    env: { DSH_EXAMPLE_MODE: { operation: 'set', value: 'lib' } },
  })
}

/**
 * Reject a plan whose graph cannot be executed unambiguously.
 * @param plan - complete or diagnostic plan to validate.
 */
export function validateGatePlan(plan: GatePlan): void {
  const errors: string[] = []
  if (plan.gates.length === 0) errors.push('plan has no gates')
  if (plan.maxWorkers !== undefined && (!Number.isSafeInteger(plan.maxWorkers) || plan.maxWorkers < 1)) {
    errors.push(`maxWorkers must be a positive integer, got ${JSON.stringify(plan.maxWorkers)}`)
  }

  const counts = new Map<string, number>()
  for (const gate of plan.gates) {
    counts.set(gate.id, (counts.get(gate.id) ?? 0) + 1)
    if (!/^[a-z0-9][a-z0-9:-]*$/.test(gate.id)) {
      errors.push(`gate id ${JSON.stringify(gate.id)} must contain only lowercase letters, digits, colons, and hyphens`)
    }
  }
  for (const [id, count] of counts) {
    if (count > 1) errors.push(`duplicate gate id ${JSON.stringify(id)}`)
  }

  const ids = new Set(counts.keys())
  for (const gate of plan.gates) {
    for (const dependency of gate.needs ?? []) {
      if (!ids.has(dependency)) {
        errors.push(`gate ${JSON.stringify(gate.id)} depends on unknown gate ${JSON.stringify(dependency)}`)
      }
    }
  }

  const cycle = findDependencyCycle(plan.gates)
  if (cycle !== undefined) errors.push(`dependency cycle: ${cycle.join(' -> ')}`)
  if (errors.length > 0) {
    throw new Error(`run-gates: invalid ${plan.mode} plan:\n${errors.map(error => `  - ${error}`).join('\n')}`)
  }
}

function findDependencyCycle(gates: readonly Gate[]): string[] | undefined {
  const byId = new Map(gates.map(gate => [gate.id, gate]))
  const complete = new Set<string>()
  const active = new Map<string, number>()
  const path: string[] = []

  const visit = (id: string): string[] | undefined => {
    if (complete.has(id)) return undefined
    const cycleStart = active.get(id)
    if (cycleStart !== undefined) return [...path.slice(cycleStart), id]
    const gate = byId.get(id)
    if (gate === undefined) return undefined

    active.set(id, path.length)
    path.push(id)
    for (const dependency of gate.needs ?? []) {
      const cycle = visit(dependency)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    active.delete(id)
    complete.add(id)
    return undefined
  }

  for (const gate of gates) {
    const cycle = visit(gate.id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/**
 * Return one target and all of its transitive dependencies in canonical plan order.
 * @param plan - validated complete owning plan.
 * @param targetId - gate selected for diagnostic execution.
 * @returns the target's dependency closure in owning-plan order.
 */
export function gateDependencyClosure(plan: GatePlan, targetId: string): Gate[] {
  validateGatePlan(plan)
  const byId = new Map(plan.gates.map(gate => [gate.id, gate]))
  if (!byId.has(targetId)) {
    throw new Error(`run-gates: ${plan.mode} has no gate ${JSON.stringify(targetId)}.`)
  }

  const selected = new Set<string>()
  const include = (id: string): void => {
    if (selected.has(id)) return
    const gate = byId.get(id)
    if (gate === undefined) throw new Error(`run-gates: missing validated dependency ${JSON.stringify(id)}.`)
    for (const dependency of gate.needs ?? []) include(dependency)
    selected.add(id)
  }
  include(targetId)
  return plan.gates.filter(gate => selected.has(gate.id))
}

/**
 * Produce the stable machine-readable view used by `--list --json`.
 * @param plan - complete plan to inspect.
 * @returns the versioned environment-redacted plan view.
 */
export function listedGatePlan(plan: GatePlan): ListedPlan {
  validateGatePlan(plan)
  return {
    version: 1,
    mode: plan.mode,
    script: plan.script,
    scope: 'complete',
    maxWorkers: plan.maxWorkers ?? null,
    gates: plan.gates.map(listedGate),
  }
}

function listedGate(gate: Gate): ListedGate {
  return {
    id: gate.id,
    label: gate.label,
    command: gate.displayCommand,
    needs: [...gate.needs ?? []],
    env: listedEnvironment(gate.env),
    blocking: gate.allowFailure !== true,
  }
}

function listedEnvironment(
  environment: Readonly<Record<string, GateEnvironmentOverride>> | undefined,
): Record<string, ListedEnvironmentOverride> {
  if (environment === undefined) return {}
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).map(([name, override]) => {
    const value = 'value' in override
      ? { value: sensitiveEnvironmentName(name) ? '<redacted>' : override.value }
      : {}
    const separator = override.operation === 'append' && override.separator !== undefined
      ? { separator: override.separator }
      : {}
    return [name, { operation: override.operation, ...value, ...separator }]
  }))
}

function sensitiveEnvironmentName(name: string): boolean {
  return /(key|secret|token|password|credential)/i.test(name)
}

/**
 * Render the deterministic human-readable view used by `--list`.
 * @param plan - complete plan to inspect.
 * @returns the formatted plan.
 */
export function formatGatePlanList(plan: GatePlan): string {
  const listed = listedGatePlan(plan)
  const lines = [
    `run-gates: complete ${listed.mode} plan (pnpm run ${listed.script})`,
    `max workers: ${listed.maxWorkers === null ? '(host and gate count)' : listed.maxWorkers}`,
  ]
  for (const gate of listed.gates) {
    lines.push(`- ${gate.id} [${gate.blocking ? 'blocking' : 'non-blocking'}] ${gate.label}`)
    lines.push(`  command: ${gate.command}`)
    lines.push(`  needs: ${gate.needs.length === 0 ? '(none)' : gate.needs.join(', ')}`)
    lines.push(`  env: ${Object.keys(gate.env).length === 0 ? '(none)' : JSON.stringify(gate.env)}`)
  }
  return lines.join('\n')
}

/**
 * Render the stable JSON view used by `--list --json`.
 * @param plan - complete plan to inspect.
 * @returns the formatted JSON object.
 */
export function formatGatePlanJson(plan: GatePlan): string {
  return JSON.stringify(listedGatePlan(plan), null, 2)
}

/**
 * Render the package-script command that restores a gate's scheduler context.
 * @param plan - complete owning plan.
 * @param gateId - gate to replay with its dependencies.
 * @returns a shell-independent pnpm command.
 */
export function replayCommand(plan: GatePlan, gateId: string): string {
  validateGatePlan(plan)
  if (!plan.gates.some(gate => gate.id === gateId)) {
    throw new Error(`run-gates: ${plan.mode} has no gate ${JSON.stringify(gateId)}.`)
  }
  return `pnpm run ${plan.script} -- --only ${gateId}`
}

/**
 * Explain that a focused run is diagnostic rather than the complete aggregate.
 * @param plan - complete owning plan.
 * @param gateId - selected diagnostic gate.
 * @returns the partial-evidence notice.
 */
export function formatOnlyNotice(plan: GatePlan, gateId: string): string {
  return `run-gates: --only ${gateId} is partial diagnostic evidence; the complete owning mode is pnpm run ${plan.script}.`
}

/**
 * Resolve only scheduler-declared environment operations against the spawn environment.
 * @param gate - gate whose operations to apply.
 * @param inherited - environment inherited by the runner.
 * @returns the child environment without mutating the inherited object.
 */
export function resolveGateEnvironment(gate: Gate, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...inherited }
  for (const [name, override] of Object.entries(gate.env ?? {})) {
    if (override.operation === 'unset') {
      Reflect.deleteProperty(resolved, name)
    } else if (override.operation === 'set') {
      resolved[name] = override.value
    } else {
      const current = resolved[name]
      resolved[name] = current === undefined || current === ''
        ? override.value
        : `${current}${override.separator ?? ' '}${override.value}`
    }
  }
  return resolved
}

/**
 * Run a validated plan; invalid input rejects before the injected executor can start a child.
 * @param plan - complete or diagnostic plan to execute.
 * @param maxActive - maximum concurrent child count.
 * @param execute - child-process executor.
 * @param observe - serialized result observer.
 * @returns results in canonical plan order.
 */
export async function executeGatePlan(
  plan: GatePlan,
  maxActive: number,
  execute: GateExecutor,
  observe: ResultObserver = () => {},
): Promise<GateResult[]> {
  validateGatePlan(plan)
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new Error(`run-gates: max concurrency must be a positive integer, got ${JSON.stringify(maxActive)}.`)
  }
  if (plan.maxWorkers !== undefined && maxActive > plan.maxWorkers) {
    throw new Error(`run-gates: max concurrency ${maxActive} exceeds the ${plan.mode} plan ceiling ${plan.maxWorkers}.`)
  }
  return runGates(plan.gates, maxActive, execute, observe)
}

/**
 * Format one private failure log without consulting or enumerating the inherited environment.
 * @param plan - complete owning plan.
 * @param result - failed child outcome.
 * @returns attributable metadata and interleaved output.
 */
export function formatGateFailureLog(plan: GatePlan, result: GateResult): string {
  const gate = listedGate(result.gate)
  const lines = [
    'run-gates failure log',
    `mode: ${plan.mode}`,
    `gate: ${gate.id}`,
    `status: ${result.status}`,
    `blocking: ${gate.blocking}`,
    `command: ${gate.command}`,
    `replay: ${replayCommand(plan, gate.id)}`,
    `scheduler environment: ${JSON.stringify(gate.env)}`,
    `exit code: ${result.exitCode === null ? 'none' : result.exitCode}`,
    `signal: ${result.signalCode ?? 'none'}`,
  ]
  if (result.error !== undefined) lines.push(`error: ${result.error}`)
  lines.push('', 'interleaved output:')
  for (const chunk of result.output) lines.push(`[${chunk.stream}]`, chunk.text)
  return `${lines.join('\n')}\n`
}

/**
 * Explain why retained logs are unavailable on a platform.
 * @param platform - host platform to evaluate.
 * @returns the console-fallback diagnostic, or `undefined` when POSIX retention is supported.
 */
export function failureLogUnavailableReason(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'win32'
    ? 'retained failure logs are disabled on Windows because POSIX owner-only permissions are unavailable; complete output remains on the console'
    : undefined
}

/**
 * Bound a UTF-8 failure log while retaining its beginning, end, and explicit truncation metadata.
 * @param content - complete formatted failure log.
 * @param maxBytes - maximum encoded byte length.
 * @returns the original log when it fits, otherwise a bounded prefix and suffix around a marker.
 */
export function limitGateFailureLog(content: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_GATE_LOG_MAX_BYTES) {
    throw new Error(`run-gates: failure-log byte limit must be an integer of at least ${MIN_GATE_LOG_MAX_BYTES}, got ${JSON.stringify(maxBytes)}.`)
  }
  const originalBytes = Buffer.byteLength(content)
  if (originalBytes <= maxBytes) return content

  const marker = `\n[run-gates log truncated: original-bytes=${originalBytes}; max-bytes=${maxBytes}]\n`
  const available = maxBytes - Buffer.byteLength(marker)
  if (available < 0) throw new Error('run-gates: failure-log truncation marker exceeds the configured byte limit.')
  const prefixBytes = Math.ceil(available / 2)
  const suffixBytes = available - prefixBytes
  return `${utf8Prefix(content, prefixBytes)}${marker}${utf8Suffix(content, suffixBytes)}`
}

function utf8Prefix(content: string, maxBytes: number): string {
  const encoded = Buffer.from(content)
  if (encoded.length <= maxBytes) return content
  let end = maxBytes
  while (end > 0) {
    const byte = encoded[end]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    end -= 1
  }
  return encoded.subarray(0, end).toString('utf8')
}

function utf8Suffix(content: string, maxBytes: number): string {
  const encoded = Buffer.from(content)
  if (encoded.length <= maxBytes) return content
  let start = encoded.length - maxBytes
  while (start < encoded.length) {
    const byte = encoded[start]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    start += 1
  }
  return encoded.subarray(start).toString('utf8')
}

/**
 * Write one exclusive owner-only POSIX failure log and keep only the newest bounded set.
 * @param plan - complete owning plan.
 * @param result - failed child outcome.
 * @param options - injectable storage, bound, clock, identity, and platform seams.
 * @returns the absolute log path.
 */
export async function writeGateFailureLog(
  plan: GatePlan,
  result: GateResult,
  options: {
    directory?: string
    repositoryRoot?: string
    retention?: number
    maxBytes?: number
    unique?: string
    now?: Date
    platform?: NodeJS.Platform
    beforeHelper?: () => Promise<void> | void
  } = {},
): Promise<string> {
  const directory = options.directory ?? gateLogRoot
  const repositoryRoot = options.repositoryRoot ?? root
  const retention = options.retention ?? GATE_LOG_RETENTION
  const maxBytes = options.maxBytes ?? GATE_LOG_MAX_BYTES
  const unique = options.unique ?? randomUUID()
  const now = options.now ?? new Date()
  const unavailable = failureLogUnavailableReason(options.platform)
  if (unavailable !== undefined) throw new Error(`run-gates: ${unavailable}.`)
  if (!Number.isSafeInteger(retention) || retention < 1) {
    throw new Error(`run-gates: log retention must be a positive integer, got ${JSON.stringify(retention)}.`)
  }
  await assertRepoLocalLogPath(repositoryRoot, directory)
  const repositoryIdentity = await readDirectoryIdentity(repositoryRoot)
  if (repositoryIdentity === undefined) throw new Error(`run-gates: repository root disappeared: ${repositoryRoot}`)
  const timestamp = now.toISOString().replaceAll(/[:.]/g, '-')
  const safeUnique = unique.replaceAll(/[^a-zA-Z0-9-]/g, '')
  if (safeUnique === '') throw new Error('run-gates: failure-log unique suffix is empty after sanitization.')
  const safeGateId = result.gate.id.replaceAll(/[^a-zA-Z0-9-]/g, '-')
  const filename = `${timestamp}-${plan.mode}-${safeGateId}-${safeUnique}.log`
  const helperResult = await runGateLogHelper(
    directory,
    repositoryRoot,
    repositoryIdentity,
    {
      operation: 'write',
      filename,
      content: limitGateFailureLog(formatGateFailureLog(plan, result), maxBytes),
      retention,
    },
    options.beforeHelper,
  )
  if (helperResult.filename !== filename) throw new Error('run-gates: gate-log helper returned the wrong filename.')
  return resolve(directory, filename)
}

async function assertRepoLocalLogPath(repositoryRoot: string, target: string): Promise<void> {
  const relativeTarget = relative(repositoryRoot, target)
  if (relativeTarget === '' || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error(`run-gates: gate-log path must be below the repository root: ${target}`)
  }

  const rootMetadata = await lstat(repositoryRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`run-gates: repository root is not a real directory: ${repositoryRoot}`)
  }
  let current = repositoryRoot
  for (const component of relativeTarget.split(sep)) {
    current = resolve(current, component)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) return
      throw error
    }
    const shown = relative(repositoryRoot, current).split(sep).join('/')
    if (metadata.isSymbolicLink()) {
      throw new Error(`run-gates: gate-log path component is a symbolic link: ${shown}`)
    }
    if (!metadata.isDirectory()) {
      throw new Error(`run-gates: gate-log path component is not a directory: ${shown}`)
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function readDirectoryIdentity(directory: string): Promise<GateLogDirectoryIdentity | undefined> {
  let metadata
  try {
    metadata = await lstat(directory, { bigint: true })
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`run-gates: gate-log path is not a real directory: ${directory}`)
  }
  return { dev: String(metadata.dev), ino: String(metadata.ino) }
}

async function runGateLogHelper(
  directory: string,
  repositoryRoot: string,
  repositoryIdentity: GateLogDirectoryIdentity,
  request: GateLogHelperRequest,
  beforeHelper: (() => Promise<void> | void) | undefined,
): Promise<GateLogHelperResult> {
  await beforeHelper?.()
  const payload = JSON.stringify({
    ...request,
    repository: {
      root: repositoryRoot,
      relative: relative(repositoryRoot, directory),
      identity: repositoryIdentity,
    },
  })
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [gateLogHelper], {
      cwd: repositoryRoot,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolveResult({ status, stdout, stderr })
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    child.stdin.end(payload)
  })
  if (result.status !== 0) {
    throw new Error(`run-gates: gate-log helper failed: ${result.stderr.trim() || `exit status ${String(result.status)}`}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`run-gates: gate-log helper returned invalid JSON: ${JSON.stringify(result.stdout)}`)
  }
  if (!isGateLogHelperResult(parsed)) throw new Error('run-gates: gate-log helper returned an invalid result.')
  await assertRepoLocalLogPath(repositoryRoot, directory)
  const currentRepositoryIdentity = await readDirectoryIdentity(repositoryRoot)
  if (
    currentRepositoryIdentity === undefined
    || currentRepositoryIdentity.dev !== repositoryIdentity.dev
    || currentRepositoryIdentity.ino !== repositoryIdentity.ino
  ) {
    throw new Error('run-gates: repository root identity changed while the gate-log helper was running.')
  }
  if (parsed.directory !== undefined) {
    const currentDirectoryIdentity = await readDirectoryIdentity(directory)
    if (
      currentDirectoryIdentity === undefined
      || currentDirectoryIdentity.dev !== parsed.directory.dev
      || currentDirectoryIdentity.ino !== parsed.directory.ino
    ) {
      throw new Error('run-gates: gate-log directory identity changed while the helper was running.')
    }
  } else if (request.operation === 'write') {
    throw new Error('run-gates: gate-log helper did not return the created directory identity.')
  }
  return parsed
}

function isGateLogHelperResult(value: unknown): value is GateLogHelperResult {
  if (typeof value !== 'object' || value === null || !('removed' in value) || !Array.isArray(value.removed)) return false
  if (!value.removed.every(entry => typeof entry === 'string')) return false
  if ('filename' in value && value.filename !== undefined && typeof value.filename !== 'string') return false
  return !('directory' in value)
    || value.directory === undefined
    || isGateLogDirectoryIdentity(value.directory)
}

function isGateLogDirectoryIdentity(value: unknown): value is GateLogDirectoryIdentity {
  return typeof value === 'object'
    && value !== null
    && 'dev' in value
    && typeof value.dev === 'string'
    && 'ino' in value
    && typeof value.ino === 'string'
}

/** Clear retained logs through a subprocess that pins the repository and each path component before use. */
export async function cleanGateFailureLogs(
  directory = gateLogRoot,
  repositoryRoot = root,
  beforeHelper?: () => Promise<void> | void,
): Promise<void> {
  await assertRepoLocalLogPath(repositoryRoot, directory)
  const repositoryIdentity = await readDirectoryIdentity(repositoryRoot)
  if (repositoryIdentity === undefined) return
  await runGateLogHelper(directory, repositoryRoot, repositoryIdentity, { operation: 'clean' }, beforeHelper)
}

/**
 * Remove older scheduler log files until at most `retain` remain.
 * @param directory - private log directory.
 * @param retain - number of newest log files to preserve.
 * @param repositoryRoot - repository boundary containing the log directory.
 * @param beforeHelper - test seam invoked after identity capture and before subprocess spawn.
 */
export async function pruneGateLogs(
  directory: string,
  retain: number,
  repositoryRoot = root,
  beforeHelper?: () => Promise<void> | void,
): Promise<void> {
  if (!Number.isSafeInteger(retain) || retain < 0) {
    throw new Error(`run-gates: retained log count must be a non-negative integer, got ${JSON.stringify(retain)}.`)
  }
  await assertRepoLocalLogPath(repositoryRoot, directory)
  const repositoryIdentity = await readDirectoryIdentity(repositoryRoot)
  if (repositoryIdentity === undefined) return
  await runGateLogHelper(directory, repositoryRoot, repositoryIdentity, { operation: 'prune', retain }, beforeHelper)
}

async function attachFailureLog(plan: GatePlan, result: GateResult): Promise<void> {
  if (result.status !== 'failed') return
  try {
    const path = await writeGateFailureLog(plan, result)
    result.logPath = relative(root, path).split(sep).join('/')
  } catch (error: unknown) {
    result.logError = error instanceof Error ? error.message : String(error)
  }
}

async function runGates(
  allGates: Gate[],
  maxActive: number,
  execute: GateExecutor,
  observe: ResultObserver,
): Promise<GateResult[]> {
  const states = new Map<string, GateStatus>(allGates.map(gate => [gate.id, 'pending']))
  const results = new Map<string, GateResult>()
  const running: RunningGate[] = []

  for (;;) {
    let madeProgress = false
    while (running.length < maxActive) {
      const ready = allGates.find(gate => states.get(gate.id) === 'pending' && dependenciesPassed(gate, states))
      if (ready === undefined) break
      states.set(ready.id, 'running')
      running.push({ gate: ready, promise: execute(ready) })
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
          signalCode: null,
          error: `dependency failed or skipped: ${failedDeps.join(', ')}`,
        }
        states.set(gate.id, 'skipped')
        results.set(gate.id, result)
        await observe(result)
      }
      break
    }

    if (!madeProgress) {
      const settled = await Promise.race(running.map(async item => ({ item, result: await item.promise })))
      running.splice(running.indexOf(settled.item), 1)
      states.set(settled.item.gate.id, settled.result.status)
      results.set(settled.item.gate.id, settled.result)
      await observe(settled.result)
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

/**
 * Execute one gate through the real shell-free child-process boundary.
 * @param gate - command and scheduler environment to execute.
 * @returns the complete process and verification outcome.
 */
export async function runGate(gate: Gate): Promise<GateResult> {
  const started = performance.now()
  let stdout = ''
  let stderr = ''
  const output: GateOutputChunk[] = []
  let spawnError: string | undefined

  const outcome = await new Promise<{
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }>((resolveExit) => {
    const child = spawn(gate.command, gate.args, {
      cwd: root,
      env: resolveGateEnvironment(gate, process.env),
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
      resolveExit({ exitCode: null, signalCode: null })
    })
    child.on('close', (exitCode, signalCode) => {
      resolveExit({ exitCode, signalCode })
    })
    if (gate.input !== undefined) child.stdin.end(gate.input)
    else child.stdin.end()
  })
  const { exitCode, signalCode } = outcome

  let status: GateStatus = exitCode === 0 && signalCode === null && spawnError === undefined ? 'passed' : 'failed'
  let error = spawnError
  if (status === 'passed' && gate.verify !== undefined) {
    try {
      await gate.verify({ gate, status, durationMs: performance.now() - started, stdout, stderr, output, exitCode, signalCode })
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
    signalCode,
  }
  if (error !== undefined) result.error = error
  return result
}

/**
 * Format every independently observed failure fact for the aggregate summary.
 * @param result - unsuccessful gate result.
 * @returns error, exit, and signal facts without allowing one to hide another.
 */
export function formatGateResultReason(result: GateResult): string {
  const facts: string[] = []
  if (result.error !== undefined) facts.push(result.error)
  if (result.exitCode !== null) facts.push(`exit ${result.exitCode}`)
  if (result.signalCode !== null) facts.push(`signal ${result.signalCode}`)
  return facts.length === 0 ? 'no exit code or signal' : facts.join(', ')
}

function printResult(plan: GatePlan, result: GateResult): void {
  const verbose = process.env.DSH_GATE_VERBOSE === '1'
  const seconds = (result.durationMs / 1000).toFixed(2)
  if (result.status === 'passed' && !verbose) {
    console.log(`run-gates: PASS ${result.gate.label} (${seconds}s)`)
    return
  }

  const heading = `${result.status.toUpperCase()} ${result.gate.label} (${seconds}s)`
  const writeHeading = result.status === 'passed' ? console.log : console.error
  writeHeading(`\n== ${heading} ==`)
  if (result.status !== 'passed') {
    const environment = listedGate(result.gate).env
    console.error(`command: ${result.gate.displayCommand}`)
    if (Object.keys(environment).length > 0) console.error(`scheduler environment: ${JSON.stringify(environment)}`)
    console.error(`replay: ${replayCommand(plan, result.gate.id)}`)
    if (result.logPath !== undefined) {
      console.error(`full log: ${result.logPath} (private; newest ${GATE_LOG_RETENTION} retained)`)
      console.error('cleanup: pnpm exec tsx scripts/run-gates.ts --clean-logs')
    }
    if (result.logError !== undefined) console.error(`full log unavailable: ${result.logError}`)
  }
  printOutput(result.output)
  if (result.error !== undefined) console.error(result.error)
}

function printSummary(plan: GatePlan, results: GateResult[], durationMs: number): void {
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
    const reason = formatGateResultReason(result)
    const disposition = result.gate.allowFailure === true ? 'NON-BLOCKING ' : ''
    console.error(`  - ${disposition}${result.status.toUpperCase()} ${result.gate.label} (${duration}s, ${reason})`)
    console.error(`    replay: ${replayCommand(plan, result.gate.id)}`)
    if (result.logPath !== undefined) console.error(`    full log: ${result.logPath}`)
  }
}

function printOutput(output: GateOutputChunk[]): void {
  for (const chunk of output) {
    if (chunk.stream === 'stdout') process.stdout.write(chunk.text)
    else process.stderr.write(chunk.text)
  }
}
