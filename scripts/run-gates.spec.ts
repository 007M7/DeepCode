import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeGatePlan,
  formatGatePlanJson,
  formatGatePlanList,
  formatGateResultReason,
  gateDependencyClosure,
  gatePlanForMode,
  listedGatePlan,
  parseCliRequest,
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
    ['unsafe ids', plan([gate('unsafe id')]), /gate id "unsafe id" must contain only lowercase letters/],
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

  it('propagates dependency skips in causal order', async () => {
    const leaf = gate('leaf', { needs: ['middle'] })
    const middle = gate('middle', { needs: ['root'] })
    const rootGate = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, 'failed'))
    const observed: string[] = []

    const results = await executeGatePlan(
      plan([leaf, middle, rootGate]),
      1,
      execute,
      result => observed.push(`${result.gate.id}:${result.status}`),
    )

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(rootGate)
    expect(observed).toEqual(['root:failed', 'middle:skipped', 'leaf:skipped'])
    expect(results.find(result => result.gate === middle)?.error).toBe('dependency failed or skipped: root')
    expect(results.find(result => result.gate === leaf)?.error).toBe('dependency failed or skipped: middle')
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

  it.skipIf(process.platform === 'win32')('executes when the script entry path is a symlink', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-run-gates-entry-'))
    const entry = join(temporary, 'run-gates.ts')
    try {
      symlinkSync(join(repositoryRoot, 'scripts/run-gates.ts'), entry)
      const result = spawnSync(process.execPath, [
        '--import',
        'tsx',
        entry,
        'ci-consumers',
        '--list',
        '--json',
      ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, npm_execpath: process.env.npm_execpath ?? '/private/pnpm.cjs' },
        timeout: 10_000,
      })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'ci-consumers', maxWorkers: 7 })
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it('prints focused-run context and replay through a real failure block', () => {
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      join(repositoryRoot, 'scripts/run-gates.ts'),
      'ci-lint',
      '--only',
      'duplication',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: join(repositoryRoot, 'scripts/missing-pnpm-entrypoint.cjs') },
      timeout: 10_000,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('partial diagnostic evidence; the complete owning mode is pnpm run check:ci:lint')
    expect(result.stderr).toContain('outcome: exit 1')
    expect(result.stderr).toContain('replay: pnpm run check:ci:lint -- --only duplication')
  })

  it('applies append and set operations through the child spawn environment', async () => {
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings')
    vi.stubEnv('INHERITED', 'kept')
    const result = await runGate(gate('subject', {
      args: ['-e', 'process.stdout.write(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS, mode: process.env.MODE, inherited: process.env.INHERITED }))'],
      env: {
        NODE_OPTIONS: { operation: 'append', value: '--max-old-space-size=8192' },
        MODE: { operation: 'set', value: 'lib' },
      },
    }))

    expect(result.status).toBe('passed')
    expect(JSON.parse(result.stdout)).toEqual({
      nodeOptions: '--trace-warnings --max-old-space-size=8192',
      mode: 'lib',
      inherited: 'kept',
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
