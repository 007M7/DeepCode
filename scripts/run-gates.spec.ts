import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanGateFailureLogs,
  executeGatePlan,
  failureLogUnavailableReason,
  formatGateFailureLog,
  formatGatePlanJson,
  formatGatePlanList,
  formatGateResultReason,
  formatOnlyNotice,
  gateDependencyClosure,
  gatePlanForMode,
  listedGatePlan,
  limitGateFailureLog,
  parseCliRequest,
  pruneGateLogs,
  replayCommand,
  resolveGateEnvironment,
  resolvePlanConcurrency,
  runGate,
  validateGatePlan,
  writeGateFailureLog,
  type Gate,
  type GatePlan,
  type GateResult,
} from './run-gates.ts'

const temporaryRoots: string[] = []
const repositoryRoot = join(import.meta.dirname, '..')

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function gate(id: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: id,
    displayCommand: `run ${id}`,
    command: process.execPath,
    args: ['-e', ''],
    ...options,
  }
}

function plan(gates: Gate[]): GatePlan {
  return { mode: 'check-all', script: 'check:all', gates }
}

function resultFor(subject: Gate, status: GateResult['status'] = 'passed'): GateResult {
  return {
    gate: subject,
    status,
    durationMs: 10,
    stdout: '',
    stderr: '',
    output: [],
    exitCode: status === 'passed' ? 0 : 1,
    signalCode: null,
  }
}

function temporaryRoot(prefix = 'dsh-gate-logs-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function withPnpmEntrypoint<T>(action: () => T): T {
  const previous = process.env.npm_execpath
  process.env.npm_execpath = '/private/pnpm.cjs'
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
    else process.env.npm_execpath = previous
  }
}

describe('gate plan validation', () => {
  it.each([
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
  ] as const)('constructs a valid non-empty %s plan', (mode) => {
    const subject = withPnpmEntrypoint(() => gatePlanForMode(mode))
    expect(() => {
      validateGatePlan(subject)
    }).not.toThrow()
  })

  it.each([
    ['empty', plan([]), /plan has no gates/],
    ['duplicate ids', plan([gate('same'), gate('same')]), /duplicate gate id "same"/],
    ['unknown dependencies', plan([gate('subject', { needs: ['missing'] })]), /depends on unknown gate "missing"/],
    ['cycles', plan([gate('first', { needs: ['second'] }), gate('second', { needs: ['first'] })]), /dependency cycle: first -> second -> first/],
  ])('rejects %s before starting a child', async (_label, invalid, message) => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))
    await expect(executeGatePlan(invalid, 1, execute)).rejects.toThrow(message)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an invalid plan worker bound', () => {
    expect(() => {
      validateGatePlan({ ...plan([gate('subject')]), maxWorkers: 0 })
    }).toThrow(
      'maxWorkers must be a positive integer',
    )
  })

  it('rejects an executor request above the plan worker ceiling before starting a child', async () => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))
    await expect(executeGatePlan({ ...plan([gate('subject')]), maxWorkers: 1 }, 2, execute)).rejects.toThrow(
      'exceeds the check-all plan ceiling 1',
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('selects a target with its transitive dependencies in canonical plan order', () => {
    const subject = plan([
      gate('prepare'),
      gate('build', { needs: ['prepare'] }),
      gate('snapshot', { needs: ['build'], env: { DSH_EXAMPLE_MODE: { operation: 'set', value: 'lib' } } }),
      gate('unrelated'),
    ])
    expect(gateDependencyClosure(subject, 'snapshot').map(item => item.id)).toEqual(['prepare', 'build', 'snapshot'])
    expect(gateDependencyClosure(subject, 'snapshot').at(-1)?.env).toEqual({
      DSH_EXAMPLE_MODE: { operation: 'set', value: 'lib' },
    })
  })
})

describe('gate plan inspection and replay', () => {
  it('parses package-script separators, list JSON, focused runs, and cleanup', () => {
    expect(parseCliRequest(['check-all', '--', '--list', '--json'])).toEqual({
      kind: 'run', mode: 'check-all', list: true, json: true,
    })
    expect(parseCliRequest(['check-all', '--only', 'snapshot'])).toEqual({
      kind: 'run', mode: 'check-all', list: false, json: false, only: 'snapshot',
    })
    expect(parseCliRequest(['--clean-logs'])).toEqual({ kind: 'clean-logs' })
    expect(() => parseCliRequest(['check-all', '--json'])).toThrow('--json requires --list')
    expect(() => parseCliRequest(['pre-push'])).toThrow('expected mode')
  })

  it('renders deterministic human and stable JSON fields without inherited environment values', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-secret')
    const subject = plan([
      gate('prepare'),
      gate('subject', {
        needs: ['prepare'],
        allowFailure: true,
        env: {
          Z_MODE: { operation: 'set', value: 'lib' },
          ACCESS_TOKEN: { operation: 'set', value: 'scheduler-secret' },
          NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' },
        },
      }),
    ])

    const json = formatGatePlanJson(subject)
    expect(formatGatePlanJson(subject)).toBe(json)
    expect(json).not.toContain('ambient-secret')
    expect(json).not.toContain('scheduler-secret')
    expect(JSON.parse(json)).toEqual({
      version: 1,
      mode: 'check-all',
      script: 'check:all',
      scope: 'complete',
      maxWorkers: null,
      gates: [
        { id: 'prepare', label: 'prepare', command: 'run prepare', needs: [], env: {}, blocking: true },
        {
          id: 'subject',
          label: 'subject',
          command: 'run subject',
          needs: ['prepare'],
          env: {
            ACCESS_TOKEN: { operation: 'set', value: '<redacted>' },
            NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' },
            Z_MODE: { operation: 'set', value: 'lib' },
          },
          blocking: false,
        },
      ],
    })
    expect(formatGatePlanList(subject)).toContain('- subject [non-blocking] subject')
    expect(formatGatePlanList(subject)).toContain('needs: prepare')
    expect(formatGatePlanList(subject)).toContain('max workers: (host and gate count)')
  })

  it('emits one clean JSON object through the documented silent package-script entry', () => {
    const result = spawnSync('pnpm', [
      '--silent',
      'run',
      'check:ci:consumers',
      '--',
      '--list',
      '--json',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 10_000,
    })
    if (result.error !== undefined) throw result.error
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      mode: 'ci-consumers',
      script: 'check:ci:consumers',
      scope: 'complete',
      maxWorkers: 7,
    })
  })

  it('renders a cross-platform scheduler replay and labels focused evidence', () => {
    const subject = plan([gate('snapshot')])
    expect(replayCommand(subject, 'snapshot')).toBe('pnpm run check:all -- --only snapshot')
    expect(formatOnlyNotice(subject, 'snapshot')).toBe(
      'run-gates: --only snapshot is partial diagnostic evidence; the complete owning mode is pnpm run check:all.',
    )
  })

  it('resolves append, set, and unset operations only when spawning', () => {
    const resolved = resolveGateEnvironment(gate('subject', {
      env: {
        NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' },
        MODE: { operation: 'set', value: 'lib' },
        REMOVE_ME: { operation: 'unset' },
      },
    }), { NODE_OPTIONS: '--trace-warnings', REMOVE_ME: 'yes', INHERITED: 'kept' })
    expect(resolved).toEqual({
      NODE_OPTIONS: '--trace-warnings --max-old-space-size=8192',
      MODE: 'lib',
      INHERITED: 'kept',
    })
  })

  it.skipIf(process.platform === 'win32')('reports signal termination as an orthogonal real-process outcome', async () => {
    const subjectGate = gate('terminated', {
      args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
    })
    const result = await runGate(subjectGate)

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.signalCode).toBe('SIGTERM')
    expect(formatGateResultReason(result)).toBe('signal SIGTERM')
    expect(formatGateFailureLog(plan([subjectGate]), result)).toContain('signal: SIGTERM')
  })
})

describe('gate failure logs', () => {
  it('records attributable scheduler metadata without inherited secrets', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-secret')
    const subjectGate = gate('snapshot', {
      env: {
        DSH_EXAMPLE_MODE: { operation: 'set', value: 'lib' },
        ACCESS_TOKEN: { operation: 'set', value: 'scheduler-secret' },
      },
    })
    const subject = plan([subjectGate])
    const failure: GateResult = {
      ...resultFor(subjectGate, 'failed'),
      output: [{ stream: 'stderr', text: 'failure details\n' }],
      stderr: 'failure details\n',
    }
    const log = formatGateFailureLog(subject, failure)
    expect(log).toContain('replay: pnpm run check:all -- --only snapshot')
    expect(log).toContain('DSH_EXAMPLE_MODE')
    expect(log).toContain('<redacted>')
    expect(log).toContain('[stderr]\nfailure details')
    expect(log).not.toContain('ambient-secret')
    expect(log).not.toContain('scheduler-secret')
  })

  it.skipIf(process.platform === 'win32')('uses private exclusive files and bounds retention', async () => {
    const repositoryRoot = temporaryRoot()
    const directory = join(repositoryRoot, '.cache/gates')
    const subjectGate = gate('subject')
    const subject = plan([subjectGate])
    const failure = resultFor(subjectGate, 'failed')

    const first = await writeGateFailureLog(subject, failure, {
      directory, repositoryRoot, retention: 2, unique: 'first', now: new Date('2026-07-27T00:00:00Z'), platform: 'linux',
    })
    const second = await writeGateFailureLog(subject, failure, {
      directory, repositoryRoot, retention: 2, unique: 'second', now: new Date('2026-07-27T00:00:01Z'), platform: 'linux',
    })
    const third = await writeGateFailureLog(subject, failure, {
      directory, repositoryRoot, retention: 2, unique: 'third', now: new Date('2026-07-27T00:00:02Z'), platform: 'linux',
    })

    expect(readdirSync(directory).sort()).toEqual([second, third].map(path => path.slice(directory.length + 1)).sort())
    expect(readFileSync(third, 'utf8')).toContain('run-gates failure log')
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(third).mode & 0o777).toBe(0o600)
    expect(() => statSync(first)).toThrow()
    await expect(writeGateFailureLog(subject, failure, {
      directory, repositoryRoot, retention: 3, unique: 'third', now: new Date('2026-07-27T00:00:02Z'), platform: 'linux',
    })).rejects.toThrow('EEXIST')
    await cleanGateFailureLogs(directory, repositoryRoot)
    expect(readdirSync(directory)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('uses cross-platform filenames for replay-safe gate ids', async () => {
    const repositoryRoot = temporaryRoot()
    const directory = join(repositoryRoot, '.cache/gates')
    const subjectGate = gate('build:web')
    const path = await writeGateFailureLog(
      plan([subjectGate]),
      resultFor(subjectGate, 'failed'),
      {
        directory, repositoryRoot, retention: 1, unique: 'unique', now: new Date('2026-07-27T00:00:00Z'), platform: 'linux',
      },
    )
    expect(path.slice(directory.length + 1)).toContain('-build-web-')
    expect(path.slice(directory.length + 1)).not.toContain(':')
  })

  it.skipIf(process.platform === 'win32')('bounds retained UTF-8 output with explicit truncation metadata', async () => {
    const repositoryRoot = temporaryRoot()
    const directory = join(repositoryRoot, '.cache/gates')
    const subjectGate = gate('subject')
    const failure: GateResult = {
      ...resultFor(subjectGate, 'failed'),
      output: [{ stream: 'stderr', text: `${'界'.repeat(200)}\nlast detail\n` }],
    }
    const path = await writeGateFailureLog(plan([subjectGate]), failure, {
      directory,
      repositoryRoot,
      retention: 1,
      maxBytes: 256,
      unique: 'bounded',
      now: new Date('2026-07-27T00:00:00Z'),
      platform: 'linux',
    })
    const content = readFileSync(path, 'utf8')

    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(256)
    expect(content).toContain('[run-gates log truncated: original-bytes=')
    expect(content).toContain('max-bytes=256')
    expect(content).toContain('last detail')
    expect(content).not.toContain('\uFFFD')
    expect(limitGateFailureLog('x'.repeat(256), 256)).toBe('x'.repeat(256))
  })

  it.skipIf(process.platform === 'win32')('accepts the worst-case JSON expansion of a bounded log', async () => {
    const repositoryRoot = temporaryRoot()
    const directory = join(repositoryRoot, '.cache/gates')
    const subjectGate = gate('subject')
    const failure: GateResult = {
      ...resultFor(subjectGate, 'failed'),
      output: [{ stream: 'stderr', text: '\0'.repeat(400_000) }],
    }
    const path = await writeGateFailureLog(plan([subjectGate]), failure, {
      directory,
      repositoryRoot,
      retention: 1,
      maxBytes: 400_000,
      unique: 'control-heavy',
      platform: 'linux',
    })

    expect(statSync(path).size).toBeLessThanOrEqual(400_000)
    expect(readFileSync(path, 'utf8')).not.toContain('\uFFFD')
  })

  it('rejects symlinked repository cache components before writing, pruning, or cleanup', async () => {
    const auditRoot = temporaryRoot('dsh-gate-symlink-')
    const repositoryRoot = join(auditRoot, 'repository')
    const external = join(auditRoot, 'external')
    const directory = join(repositoryRoot, '.cache/gates')
    mkdirSync(repositoryRoot)
    mkdirSync(join(external, 'gates'), { recursive: true })
    const victim = join(external, 'gates/victim.log')
    writeFileSync(victim, 'keep\n')
    symlinkSync(external, join(repositoryRoot, '.cache'), process.platform === 'win32' ? 'junction' : 'dir')
    const subjectGate = gate('subject')
    const message = 'gate-log path component is a symbolic link: .cache'

    await expect(writeGateFailureLog(plan([subjectGate]), resultFor(subjectGate, 'failed'), {
      directory, repositoryRoot, retention: 1, unique: 'safe', platform: 'linux',
    })).rejects.toThrow(message)
    await expect(pruneGateLogs(directory, 0, repositoryRoot)).rejects.toThrow(message)
    await expect(cleanGateFailureLogs(directory, repositoryRoot)).rejects.toThrow(message)
    expect(existsSync(victim)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('pins write, prune, and cleanup before a concurrent ancestor swap', async () => {
    const subjectGate = gate('subject')
    const subject = plan([subjectGate])

    for (const operation of ['write', 'prune', 'clean'] as const) {
      const auditRoot = temporaryRoot(`dsh-gate-${operation}-swap-`)
      const repositoryRoot = join(auditRoot, 'repository')
      const external = join(auditRoot, 'external')
      const cache = join(repositoryRoot, '.cache')
      const directory = join(cache, 'gates')
      const displacedCache = join(repositoryRoot, '.cache-pinned')
      mkdirSync(directory, { recursive: true })
      mkdirSync(external)
      writeFileSync(join(directory, 'old.log'), 'old private log\n')
      const victim = operation === 'write' ? undefined : join(external, 'gates/victim.log')
      if (victim !== undefined) {
        mkdirSync(join(external, 'gates'))
        writeFileSync(victim, 'keep\n')
      }
      const swapAncestor = (): void => {
        renameSync(cache, displacedCache)
        symlinkSync(external, cache, 'dir')
      }

      let invocation: Promise<unknown>
      if (operation === 'write') {
        invocation = writeGateFailureLog(subject, resultFor(subjectGate, 'failed'), {
          directory,
          repositoryRoot,
          retention: 1,
          unique: operation,
          platform: 'linux',
          beforeHelper: swapAncestor,
        })
      } else if (operation === 'prune') {
        invocation = pruneGateLogs(directory, 0, repositoryRoot, swapAncestor)
      } else {
        invocation = cleanGateFailureLogs(directory, repositoryRoot, swapAncestor)
      }

      await expect(invocation).rejects.toThrow('gate-log helper')
      if (victim === undefined) {
        expect(existsSync(join(external, 'gates'))).toBe(false)
      } else {
        expect(readFileSync(victim, 'utf8')).toBe('keep\n')
        expect(readdirSync(join(external, 'gates'))).toEqual(['victim.log'])
      }
      expect(readFileSync(join(displacedCache, 'gates/old.log'), 'utf8')).toBe('old private log\n')
    }
  })

  it('uses a console-only fallback on Windows before creating a retention directory', async () => {
    const repositoryRoot = temporaryRoot()
    const directory = join(repositoryRoot, '.cache/gates')
    const subjectGate = gate('subject')
    expect(failureLogUnavailableReason('win32')).toContain('complete output remains on the console')
    expect(failureLogUnavailableReason('linux')).toBeUndefined()

    await expect(writeGateFailureLog(plan([subjectGate]), resultFor(subjectGate, 'failed'), {
      directory, repositoryRoot, platform: 'win32',
    })).rejects.toThrow('retained failure logs are disabled on Windows')
    expect(existsSync(directory)).toBe(false)
  })
})

describe('Node 24 consumer plan', () => {
  it('owns the same seven-worker command pool and orders restored-artifact validation before dependent consumers', () => {
    const subject = withPnpmEntrypoint(() => gatePlanForMode('ci-consumers'))
    validateGatePlan(subject)
    expect(subject.maxWorkers).toBe(7)
    expect(listedGatePlan(subject).maxWorkers).toBe(7)
    expect(resolvePlanConcurrency(subject, undefined, 4)).toEqual({
      workers: 7,
      source: 'ci-consumers plan default 7',
    })
    expect(resolvePlanConcurrency(subject, '4', 32)).toEqual({
      workers: 4,
      source: '$DSH_GATE_CONCURRENCY',
    })
    expect(resolvePlanConcurrency(subject, '8', 32)).toEqual({
      workers: 7,
      source: '$DSH_GATE_CONCURRENCY, ci-consumers plan cap 7',
    })
    expect(subject.gates.map(item => item.id)).toEqual([
      'lint-and-duplication',
      'node-compat',
      'snapshot',
      'publint',
      'node-next-types',
      'built-package-invariants',
      'built-bin-smoke',
    ])
    expect(subject.gates.find(item => item.id === 'publint')?.needs).toBeUndefined()
    expect(subject.gates.find(item => item.id === 'built-package-invariants')?.needs).toEqual(['publint'])
    for (const id of ['snapshot', 'node-next-types', 'built-bin-smoke']) {
      expect(subject.gates.find(item => item.id === id)?.needs).toEqual(['built-package-invariants'])
    }
    expect(gateDependencyClosure(subject, 'snapshot').map(item => item.id)).toEqual([
      'snapshot',
      'publint',
      'built-package-invariants',
    ])
    expect(listedGatePlan(subject).gates.find(item => item.id === 'snapshot')?.env).toEqual({
      DSH_EXAMPLE_MODE: { operation: 'set', value: 'lib' },
    })
  })
})
