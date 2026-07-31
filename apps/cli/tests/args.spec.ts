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
  it('routes each mode by its shape: default TUI, -p headless, experimental and web subcommands', () => {
    expect(parse([])).toEqual({ mode: 'tui' })
    expect(parse(['--config', 'custom.yml'])).toEqual({ mode: 'tui', config: 'custom.yml' })
    expect(parse(['--config-replace', 'tree.yml'])).toEqual({ mode: 'tui', configReplace: 'tree.yml' })
    expect(parse(['--resume', 'sess', '--config', 'app.yml'])).toEqual({ mode: 'tui', config: 'app.yml', resume: 'sess' })
    expect(parse(['-p', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
    expect(parse(['experimental-meta'])).toEqual({ mode: 'meta' })
    // Bare `web` carries no host/port: the shipped Web overlay owns the default.
    expect(parse(['web'])).toEqual({ mode: 'web', dev: false })
    expect(parse(['web', '--config', 'web.yml'])).toEqual({ mode: 'web', dev: false, config: 'web.yml' })
    // Host/port are unvalidated pass-throughs (the webserver schema gates them
    // at boot); the adapter only coerces the port string to a number.
    expect(parse(['web', '--host', '0.0.0.0', '--port', '8080', '--dev', '--workspace-root', '/w']))
      .toEqual({ mode: 'web', host: '0.0.0.0', port: 8080, dev: true, workspaceRoot: '/w' })
    // Guided fresh-session entries carry nothing: bare mode discriminant only.
    expect(parse(['experimental-upgrade'])).toEqual({ mode: 'upgrade' })
    // --trusted-host is variadic and repeatable; authorities pass through unvalidated.
    expect(parse(['web', '--trusted-host', 'harness.internal:3080', 'lab.internal', '--trusted-host', '10.0.0.9']))
      .toEqual({ mode: 'web', dev: false, trustedHosts: ['harness.internal:3080', 'lab.internal', '10.0.0.9'] })
  })

  it('routes the dump flags per surface: composed with the user layer, or shipped only', () => {
    expect(parse(['--dump-config'])).toEqual({ mode: 'dump-config', surface: 'tui', defaultOnly: false })
    expect(parse(['--dump-config', '--config', 'c.yml']))
      .toEqual({ mode: 'dump-config', surface: 'tui', defaultOnly: false, config: 'c.yml' })
    expect(parse(['--dump-default-config'])).toEqual({ mode: 'dump-config', surface: 'tui', defaultOnly: true })
    expect(parse(['web', '--dump-config'])).toEqual({ mode: 'dump-config', surface: 'web', defaultOnly: false })
    expect(parse(['web', '--dump-config', '--config', 'w.yml']))
      .toEqual({ mode: 'dump-config', surface: 'web', defaultOnly: false, config: 'w.yml' })
    expect(parse(['web', '--dump-default-config'])).toEqual({ mode: 'dump-config', surface: 'web', defaultOnly: true })
    // The two dump flags contradict each other; boot-only flags alongside a
    // dump would be silently ignored; the shipped tree takes no user overlay.
    expect(exitCode(['--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['--dump-default-config', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['--dump-config', '--resume', 's'])).toBe(1)
    expect(exitCode(['--dump-config', '-p', 'task'])).toBe(1)
    expect(exitCode(['--dump-config', '--config-replace', 'tree.yml'])).toBe(1)
    expect(exitCode(['web', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['web', '--dump-default-config', '--config', 'w.yml'])).toBe(1)
    // A leaked dump flag on a subcommand that has none is a mistyped invocation.
    expect(exitCode(['experimental-meta', '--dump-config'])).toBe(1)
    expect(exitCode(['experimental-upgrade', '--dump-config'])).toBe(1)
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
    // `experimental-meta` fixes its own config tree and always starts fresh,
    // so every default-surface option is rejected.
    expect(exitCode(['experimental-meta', '--resume', 's'])).toBe(1)
    expect(exitCode(['experimental-meta', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['experimental-meta', '--config-replace', 'tree.yml'])).toBe(1)
    expect(exitCode(['experimental-meta', '-p', 'task'])).toBe(1)
    // `experimental-upgrade` takes no options: any leaked default-surface flag
    // is a mistyped invocation, not a silently-dropped input.
    expect(exitCode(['experimental-upgrade', '--resume', 's'])).toBe(1)
    expect(exitCode(['experimental-upgrade', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['-p', 'task', 'experimental-upgrade'])).toBe(1)
    // The pre-release command names have no compatibility aliases.
    expect(exitCode(['meta'])).toBe(1)
    expect(exitCode(['upgrade'])).toBe(1)
  })

  it('exits 0 for --help (disclosing web) and --version', () => {
    expect(exitCode(['--help'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})
