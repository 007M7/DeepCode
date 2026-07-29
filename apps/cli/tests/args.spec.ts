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
    expect(parse(['--resume', 'sess', '--config', 'app.yml'])).toEqual({ mode: 'tui', config: 'app.yml', resume: 'sess' })
    expect(parse(['-p', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
    // `meta` accepts `--resume` but does not redeclare it: a shared option parses
    // into program.opts() on either side of the subcommand, and redeclaring it
    // would leave the subcommand's own options empty and drop the id.
    expect(parse(['meta'])).toEqual({ mode: 'meta' })
    expect(parse(['meta', '--resume', 'sess'])).toEqual({ mode: 'meta', resume: 'sess' })
    expect(parse(['--resume', 'sess', 'meta'])).toEqual({ mode: 'meta', resume: 'sess' })
    // Credential setup is option-free: it writes the Harness-home .env, so
    // there is nothing for a flag to select.
    // Bare `web` carries no host/port: the shipped cordis.yml owns the default.
    expect(parse(['web'])).toEqual({ mode: 'web', dev: false })
    // Host/port are unvalidated pass-throughs (the webserver schema gates them
    // at boot); the adapter only coerces the port string to a number.
    expect(parse(['web', '--host', '0.0.0.0', '--port', '8080', '--dev', '--workspace-root', '/w']))
      .toEqual({ mode: 'web', host: '0.0.0.0', port: 8080, dev: true, workspaceRoot: '/w' })
    // Guided fresh-session entries carry nothing: bare mode discriminant only.
    expect(parse(['migrate'])).toEqual({ mode: 'migrate' })
    expect(parse(['upgrade'])).toEqual({ mode: 'upgrade' })
    // `list-sessions` has one option and no workspace filter: the listing is always
    // global. `ps` is its alias and resolves to the same mode.
    expect(parse(['list-sessions'])).toEqual({ mode: 'list-sessions', json: false })
    expect(parse(['list-sessions', '--json'])).toEqual({ mode: 'list-sessions', json: true })
    expect(parse(['ps', '--json'])).toEqual({ mode: 'list-sessions', json: true })
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
    expect(exitCode(['-p', 'x', '--resume', 's'])).toBe(1)
    expect(exitCode(['--bogus'])).toBe(1)
    expect(exitCode(['bogus-positional'])).toBe(1)
    // A default-surface flag on either side of `web` leaks into program.opts()
    // but the web subcommand shares none of them: reject rather than serve.
    expect(exitCode(['web', '-p', 'task'])).toBe(1)
    expect(exitCode(['web', '--resume', 's'])).toBe(1)
    expect(exitCode(['--config', 'c.yml', 'web'])).toBe(1)
    // Same rule for credential setup: it shares no option with the default
    // surface, so a leaked flag is a typo, not something to ignore.
    // `meta` fixes its own config tree and is interactive, so --config/-p are
    // rejected; an empty id is swallowed downstream exactly as above.
    expect(exitCode(['meta', '--resume='])).toBe(1)
    expect(exitCode(['meta', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['meta', '-p', 'task'])).toBe(1)
    // `migrate`/`upgrade` take no options: any leaked default-surface flag is a
    // mistyped invocation, not a silently-dropped input.
    expect(exitCode(['migrate', '--resume', 's'])).toBe(1)
    expect(exitCode(['migrate', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['migrate', '-p', 'task'])).toBe(1)
    expect(exitCode(['upgrade', '--resume', 's'])).toBe(1)
    expect(exitCode(['upgrade', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['-p', 'task', 'upgrade'])).toBe(1)
    // `list-sessions`/`ps` is read-only and shares no default-surface option: a leaked flag is a
    // mistyped invocation, not a listing with a silently dropped input.
    expect(exitCode(['ps', '--resume', 's'])).toBe(1)
    expect(exitCode(['list-sessions', '--config', 'c.yml'])).toBe(1)
    expect(exitCode(['list-sessions', '-p', 'task'])).toBe(1)
    expect(exitCode(['--resume', 's', 'ps'])).toBe(1)
  })

  it('exits 0 for --help (disclosing web) and --version', () => {
    expect(exitCode(['--help'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})
