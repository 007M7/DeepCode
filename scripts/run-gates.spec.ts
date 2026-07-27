import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeGatePlan,
  formatGatePlanJson,
  formatGatePlanList,
  formatGateResultReason,
  formatOnlyNotice,
  gateDependencyClosure,
  gatePlanForMode,
  listedGatePlan,
  parseCliRequest,
  replayCommand,
  resolveGateEnvironment,
  resolvePlanConcurrency,
  runGate,
  validateGatePlan,
  type Gate,
  type GatePlan,
  type GateResult,
} from './run-gates.ts'

const repositoryRoot = join(import.meta.dirname, '..')

afterEach(() => vi.unstubAllEnvs())

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

  it('reports a settled failure before an unrelated gate finishes', async () => {
    const first = gate('first')
    const second = gate('second')
    const settle = new Map<string, (result: GateResult) => void>()
    const observed: string[] = []
    const execution = executeGatePlan(
      plan([first, second]),
      2,
      subject => new Promise(resolve => settle.set(subject.id, resolve)),
      result => observed.push(`${result.gate.id}:${result.status}`),
    )

    const settleFirst = settle.get(first.id)
    const settleSecond = settle.get(second.id)
    if (settleFirst === undefined || settleSecond === undefined) throw new Error('expected both gates to start')
    settleFirst(resultFor(first, 'failed'))
    await vi.waitFor(() => {
      expect(observed).toEqual(['first:failed'])
    })
    settleSecond(resultFor(second))

    await expect(execution).resolves.toHaveLength(2)
    expect(observed).toEqual(['first:failed', 'second:passed'])
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
  it('parses package-script separators, list JSON, and focused runs', () => {
    expect(parseCliRequest(['check-all', '--', '--list', '--json'])).toEqual({
      mode: 'check-all', list: true, json: true,
    })
    expect(parseCliRequest(['check-all', '--only', 'snapshot'])).toEqual({
      mode: 'check-all', list: false, json: false, only: 'snapshot',
    })
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

  it('resolves append and set operations only when spawning', () => {
    const resolved = resolveGateEnvironment(gate('subject', {
      env: {
        NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' },
        MODE: { operation: 'set', value: 'lib' },
      },
    }), { NODE_OPTIONS: '--trace-warnings', INHERITED: 'kept' })
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
