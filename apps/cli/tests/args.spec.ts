import { describe, expect, it } from 'vitest'
import { ALL_INTERFACES_HOST, LOOPBACK_HOST, parseDshArgs } from '../src/args.ts'

const VERSION = '1.2.3'
const parse = (argv: string[]) => parseDshArgs(argv, VERSION)

/** Assert argv resolves to an error invocation whose message contains `needle`. */
function expectError(argv: string[], needle: string): void {
  const result = parse(argv)
  expect(result.mode).toBe('error')
  if (result.mode !== 'error') throw new Error('expected error mode')
  expect(result.message).toContain(needle)
}

describe('parseDshArgs — TUI (default mode)', () => {
  it('defaults to the TUI with no config and no resume when given no arguments', () => {
    expect(parse([])).toEqual({ mode: 'tui' })
  })

  it('carries a positional config into the TUI mode', () => {
    expect(parse(['custom.yml'])).toEqual({ mode: 'tui', config: 'custom.yml' })
  })

  it('parses --resume in the space and inline forms, independent of a config positional', () => {
    expect(parse(['--resume', 'sess-1'])).toEqual({ mode: 'tui', resume: 'sess-1' })
    expect(parse(['--resume=sess-2'])).toEqual({ mode: 'tui', resume: 'sess-2' })
    expect(parse(['--resume', 'sess-3', 'app.yml'])).toEqual({ mode: 'tui', config: 'app.yml', resume: 'sess-3' })
    expect(parse(['app.yml', '--resume', 'sess-4'])).toEqual({ mode: 'tui', config: 'app.yml', resume: 'sess-4' })
  })

  it('fails loud on a valueless or empty --resume rather than silently starting fresh', () => {
    expectError(['--resume'], '--resume')
    expectError(['--resume='], 'must not be empty')
  })

  it('rejects a repeated --resume instead of silently keeping the last id', () => {
    expectError(['--resume', 'a', '--resume', 'b'], 'may be given only once')
    expectError(['--resume=a', '--resume=b'], 'may be given only once')
  })
})

describe('parseDshArgs — headless', () => {
  it('routes -p / --prompt to the headless mode with the task text', () => {
    expect(parse(['-p', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
    expect(parse(['--prompt', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
  })

  it('routes to headless regardless of the prompt flag position', () => {
    // Positional-independent: the old `argv.includes('-p')` dispatch could not
    // tell a real prompt flag from one buried after other tokens.
    expect(parse(['-p', 'task'])).toEqual({ mode: 'headless', prompt: 'task' })
  })

  it('rejects an empty prompt and a stray config positional', () => {
    expectError(['-p', ''], 'must not be empty')
    expectError(['-p', 'task', 'app.yml'], 'takes no config')
  })
})

describe('parseDshArgs — web', () => {
  it('defaults the web mode to loopback and port 3080', () => {
    expect(parse(['web'])).toEqual({ mode: 'web', host: LOOPBACK_HOST, port: 3080 })
  })

  it('accepts an explicit loopback or all-interfaces host and a valid port', () => {
    expect(parse(['web', '--host', ALL_INTERFACES_HOST, '--port', '8080']))
      .toEqual({ mode: 'web', host: ALL_INTERFACES_HOST, port: 8080 })
    expect(parse(['web', '--port', '0'])).toEqual({ mode: 'web', host: LOOPBACK_HOST, port: 0 })
  })

  it('rejects a non-integer or out-of-range port with a --port diagnostic', () => {
    expectError(['web', '--port', 'abc'], '--port')
    expectError(['web', '--port', '70000'], '--port')
    expectError(['web', '--port', '-1'], '--port')
  })

  it('rejects a host outside the allowed choices with a --host diagnostic', () => {
    expectError(['web', '--host', '10.0.0.1'], '--host')
  })

  it('rejects an unexpected positional after web', () => {
    expectError(['web', 'extra'], 'too many arguments')
  })

  it('fails loud when a root flag is placed before web instead of serving with it dropped', () => {
    // `dsh web -p x` and `dsh -p x web` both misrouted or dropped the flag under
    // the old `argv[0]==='web'` / `argv.includes('-p')` dispatch.
    expectError(['web', '-p', 'x'], "unknown option '-p'")
    expectError(['web', '--resume', 'y'], "unknown option '--resume'")
    expectError(['-p', 'x', 'web'], 'web takes no')
    expectError(['--resume', 'y', 'web'], 'web takes no')
  })

  it('renders web usage for web --help', () => {
    const help = parse(['web', '--help'])
    expect(help.mode).toBe('help')
    if (help.mode !== 'help') throw new Error('expected help mode')
    expect(help.text).toContain('Usage: dsh web')
  })
})

describe('parseDshArgs — help, version, and errors', () => {
  it('returns the rendered usage for --help / -h', () => {
    const help = parse(['--help'])
    expect(help.mode).toBe('help')
    if (help.mode !== 'help') throw new Error('expected help mode')
    expect(help.text).toContain('Usage: dsh')
    expect(help.text).toContain('web')
    expect(parse(['-h']).mode).toBe('help')
  })

  it('returns the version string for --version / -V', () => {
    expect(parse(['--version'])).toEqual({ mode: 'version', text: `${VERSION}\n` })
    expect(parse(['-V'])).toEqual({ mode: 'version', text: `${VERSION}\n` })
  })

  it('reports an unknown option as an error invocation', () => {
    expectError(['--nope'], "unknown option '--nope'")
  })
})
