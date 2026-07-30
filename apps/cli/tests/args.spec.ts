import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDshArgs } from '../src/args.ts'

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
  it('routes each mode by its shape: default TUI, -p headless, meta and web subcommands', () => {
    expect(parse([])).toEqual({ mode: 'tui' })
    expect(parse(['--config', 'custom.yml'])).toEqual({ mode: 'tui', config: 'custom.yml' })
    expect(parse(['--config-replace', 'tree.yml'])).toEqual({ mode: 'tui', configReplace: 'tree.yml' })
    expect(parse(['--resume', 'sess', '--config', 'app.yml'])).toEqual({ mode: 'tui', config: 'app.yml', resume: 'sess' })
    expect(parse(['-p', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
    expect(parse(['meta'])).toEqual({ mode: 'meta' })
    // Bare `web` carries no host/port: the shipped Web overlay owns the default.
    expect(parse(['web'])).toEqual({ mode: 'web', dev: false })
    expect(parse(['web', '--config', 'web.yml'])).toEqual({ mode: 'web', dev: false, config: 'web.yml' })
    // Host/port are unvalidated pass-throughs (the webserver schema gates them
    // at boot); the adapter only coerces the port string to a number.
    expect(parse(['web', '--host', '0.0.0.0', '--port', '8080', '--dev', '--workspace-root', '/w']))
      .toEqual({ mode: 'web', host: '0.0.0.0', port: 8080, dev: true, workspaceRoot: '/w' })
    // Guided fresh-session entries carry nothing: bare mode discriminant only.
    expect(parse(['upgrade'])).toEqual({ mode: 'upgrade' })
    // --trusted-host is variadic and repeatable; authorities pass through unvalidated.
    expect(parse(['web', '--trusted-host', 'harness.internal:3080', 'lab.internal', '--trusted-host', '10.0.0.9']))
      .toEqual({ mode: 'web', dev: false, trustedHosts: ['harness.internal:3080', 'lab.internal', '10.0.0.9'] })
  })

  it('exits nonzero instead of silently starting fresh or dropping inputs', () => {
    // Empty resume/prompt would be swallowed downstream; --prompt mixed with
    // TUI inputs must not lose them. (Bad host/port are gated by the webserver
    // schema at boot, not here.)
    expect(exitCode(['--resume='])).toBe(1)
    expect(exitCode(['-p', ''])).toBe(1)
    expect(exitCode(['-p', 'x', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['-p', 'x', '--config-replace', 'tree.yml'])).toBe(1)
    expect(exitCode(['--config', 'c.yml', '--config-replace', 'tree.yml'])).toBe(1)
    expect(exitCode(['-p', 'x', '--resume', 's'])).toBe(1)
    expect(exitCode(['--bogus'])).toBe(1)
    expect(exitCode(['bogus-positional'])).toBe(1)
    // A default-surface flag on either side of `web` leaks into program.opts()
    // but the web subcommand shares none of them: reject rather than serve.
    expect(exitCode(['web', '-p', 'task'])).toBe(1)
    expect(exitCode(['web', '--resume', 's'])).toBe(1)
    expect(exitCode(['--config', 'c.yml', 'web'])).toBe(1)
    expect(exitCode(['--config-replace', 'tree.yml', 'web'])).toBe(1)
    // Same rule for each subcommand that shares no option with the default
    // surface, so a leaked flag is a typo, not something to ignore.
    // `meta` fixes its own config tree and always starts fresh, so every
    // default-surface option is rejected.
    expect(exitCode(['meta', '--resume', 's'])).toBe(1)
    expect(exitCode(['meta', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['meta', '--config-replace', 'tree.yml'])).toBe(1)
    expect(exitCode(['meta', '-p', 'task'])).toBe(1)
    // `upgrade` takes no options: any leaked default-surface flag is a
    // mistyped invocation, not a silently-dropped input.
    expect(exitCode(['upgrade', '--resume', 's'])).toBe(1)
    expect(exitCode(['upgrade', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['-p', 'task', 'upgrade'])).toBe(1)
  })

  it('exits 0 for --help (disclosing web) and --version', () => {
    expect(exitCode(['--help'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})
