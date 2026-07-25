import { describe, expect, it } from 'vitest'
import { ALL_INTERFACES_HOST, LOOPBACK_HOST, parseDshArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseDshArgs(argv, '1.2.3')

describe('parseDshArgs', () => {
  it('routes each mode by its shape: default TUI, -p headless, web subcommand', () => {
    expect(parse([])).toEqual({ mode: 'tui' })
    expect(parse(['custom.yml'])).toEqual({ mode: 'tui', config: 'custom.yml' })
    expect(parse(['--resume', 'sess', 'app.yml'])).toEqual({ mode: 'tui', config: 'app.yml', resume: 'sess' })
    expect(parse(['-p', 'do the thing'])).toEqual({ mode: 'headless', prompt: 'do the thing' })
    expect(parse(['web'])).toEqual({ mode: 'web', host: LOOPBACK_HOST, port: 3080, dev: false })
    expect(parse(['web', '--host', ALL_INTERFACES_HOST, '--port', '8080']))
      .toEqual({ mode: 'web', host: ALL_INTERFACES_HOST, port: 8080, dev: false })
    expect(parse(['web', '--dev'])).toEqual({ mode: 'web', host: LOOPBACK_HOST, port: 3080, dev: true })
  })

  it('fails loud instead of silently starting fresh or serving on bad input', () => {
    // An empty resume/prompt would otherwise be swallowed (agent-loop treats an
    // empty resume id as no-resume); a bad host/port must not reach the listener.
    expect(parse(['--resume=']).mode).toBe('error')
    expect(parse(['-p', '']).mode).toBe('error')
    expect(parse(['web', '--host', '10.0.0.1']).mode).toBe('error')
    expect(parse(['web', '--port', 'abc']).mode).toBe('error')
    expect(parse(['--bogus']).mode).toBe('error')
  })

  it('surfaces --help and --version as printable data, not a process exit', () => {
    const help = parse(['--help'])
    expect(help).toMatchObject({ mode: 'help' })
    if (help.mode === 'help') expect(help.text).toContain('Usage: dsh')
    expect(parse(['--version'])).toEqual({ mode: 'version', text: '1.2.3\n' })
  })
})
