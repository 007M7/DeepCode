import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_INTERFACES_HOST, LOOPBACK_HOST, parseDshArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseDshArgs(argv, '1.2.3')

/**
 * `parseDshArgs` calls `process.exit` for `--help`/`--version`/errors and lets
 * Commander print to the real streams; capture the exit code and mute output.
 */
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
  it('routes each mode by its shape: default TUI, -p headless, web subcommand', () => {
    expect(parse([])).toEqual({ mode: 'tui' })
    expect(parse(['custom.yml'])).toEqual({ mode: 'tui', config: 'custom.yml' })
    expect(parse(['--resume', 'sess', 'app.yml'])).toEqual({ mode: 'tui', config: 'app.yml', resume: 'sess' })
    expect(parse(['-p', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
    expect(parse(['web'])).toEqual({ mode: 'web', host: LOOPBACK_HOST, port: 3080, dev: false })
    expect(parse(['web', '--host', ALL_INTERFACES_HOST, '--port', '8080', '--dev']))
      .toEqual({ mode: 'web', host: ALL_INTERFACES_HOST, port: 8080, dev: true })
  })

  it('exits nonzero instead of silently starting fresh, serving, or dropping inputs', () => {
    // Empty resume/prompt would be swallowed downstream; bad host/port must not
    // reach the listener; --prompt mixed with TUI inputs must not lose them.
    expect(exitCode(['--resume='])).toBe(1)
    expect(exitCode(['-p', ''])).toBe(1)
    expect(exitCode(['web', '--host', '10.0.0.1'])).toBe(1)
    expect(exitCode(['web', '--port', 'abc'])).toBe(1)
    expect(exitCode(['web', '--port='])).toBe(1)
    expect(exitCode(['config.yml', '-p', 'x'])).toBe(1)
    expect(exitCode(['--bogus'])).toBe(1)
  })

  it('exits 0 for --help (disclosing web) and --version', () => {
    expect(exitCode(['--help'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})
