import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDshArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseDshArgs(argv, '1.2.3')

/** Capture the process exit code while muting Commander's output. */
function exitCode(argv: string[]): number {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    parse(argv)
    throw new Error(`expected ${JSON.stringify(argv)} to exit`)
  } catch {
    return exit.mock.calls.at(-1)?.[0] as number
  } finally {
    vi.restoreAllMocks()
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseDshArgs', () => {
  it('routes the required raw config, one-shot prompt, and Web command', () => {
    expect(parse(['--config', 'custom.yml'])).toEqual({ mode: 'config', config: 'custom.yml' })
    expect(parse(['-p', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
    expect(parse(['web'])).toEqual({ mode: 'web', dev: false })
    expect(parse(['web', '--config', 'web.yml'])).toEqual({ mode: 'web', dev: false, config: 'web.yml' })
    expect(parse(['web', '--host', '0.0.0.0', '--port', '8080', '--dev', '--workspace-root', '/w']))
      .toEqual({ mode: 'web', host: '0.0.0.0', port: 8080, dev: true, workspaceRoot: '/w' })
    expect(parse(['web', '--trusted-host', 'harness.internal:3080', 'lab.internal', '--trusted-host', '10.0.0.9']))
      .toEqual({ mode: 'web', dev: false, trustedHosts: ['harness.internal:3080', 'lab.internal', '10.0.0.9'] })
  })

  it('routes raw and Web config dumps', () => {
    expect(parse(['--config', 'c.yml', '--dump-config']))
      .toEqual({ mode: 'dump-config', surface: 'config', defaultOnly: false, config: 'c.yml' })
    expect(parse(['--dump-default-config']))
      .toEqual({ mode: 'dump-config', surface: 'config', defaultOnly: true })
    expect(parse(['web', '--dump-config']))
      .toEqual({ mode: 'dump-config', surface: 'web', defaultOnly: false })
    expect(parse(['web', '--dump-config', '--config', 'w.yml']))
      .toEqual({ mode: 'dump-config', surface: 'web', defaultOnly: false, config: 'w.yml' })
    expect(parse(['web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', surface: 'web', defaultOnly: true })
  })

  it('rejects missing config, removed commands, and contradictory inputs', () => {
    expect(exitCode([])).toBe(1)
    expect(exitCode(['tui'])).toBe(1)
    expect(exitCode(['meta'])).toBe(1)
    expect(exitCode(['upgrade'])).toBe(1)
    expect(exitCode(['--dump-config'])).toBe(1)
    expect(exitCode(['--dump-config', '--dump-default-config', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['--dump-default-config', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['--dump-config', '--config', 'c.yml', '-p', 'task'])).toBe(1)
    expect(exitCode(['-p', ''])).toBe(1)
    expect(exitCode(['--config='])).toBe(1)
    expect(exitCode(['-p', 'x', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['--bogus'])).toBe(1)
    expect(exitCode(['bogus-positional'])).toBe(1)
    expect(exitCode(['web', '-p', 'task'])).toBe(1)
    expect(exitCode(['--config', 'c.yml', 'web'])).toBe(1)
    expect(exitCode(['web', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['web', '--dump-default-config', '--config', 'w.yml'])).toBe(1)
    expect(exitCode(['web', '--config='])).toBe(1)
  })

  it('exits 0 for help and version', () => {
    expect(exitCode(['--help'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})
