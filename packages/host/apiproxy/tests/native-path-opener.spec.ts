type ExecFileCallback = (
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: { encoding: string; signal: AbortSignal; windowsHide: boolean },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { describe, expect, it, vi } from 'vitest'
import { openNativePath, type PathOpenerRunner } from '../src/native-path-opener.ts'

const signal = () => new AbortController().signal

describe('native path opener', () => {
  it('opens with macOS open(1)', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath('/Users/test/file.txt', signal(), { platform: 'darwin', run })
    expect(run).toHaveBeenCalledWith('open', ['/Users/test/file.txt'], expect.any(AbortSignal))
  })

  it('opens with Windows Invoke-Item and escapes single quotes', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath("C:\\work\\o'reilly.txt", signal(), { platform: 'win32', run })
    expect(run).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', "Invoke-Item -LiteralPath 'C:\\work\\o''reilly.txt'"],
      expect.any(AbortSignal),
    )
  })

  it('opens with Linux xdg-open', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath('/tmp/a.txt', signal(), { platform: 'linux', run })
    expect(run).toHaveBeenCalledWith('xdg-open', ['/tmp/a.txt'], expect.any(AbortSignal))
  })

  it('rejects unsupported platforms', async () => {
    await expect(openNativePath('/x', signal(), { platform: 'freebsd' as NodeJS.Platform }))
      .rejects.toThrow('unsupported on freebsd')
  })

  it('uses the current process platform when no platform override is supplied', async () => {
    const run = vi.fn<PathOpenerRunner>(async () => ({ stdout: '', stderr: '' }))
    await openNativePath('/tmp/platform-default.txt', signal(), { run })
    const expected = process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'linux'
        ? 'xdg-open'
        : 'open'
    expect(run.mock.calls[0]?.[0]).toBe(expected)
  })

  it('runs the default command adapter without a shell and preserves command failures', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, '', '')
    })
    await openNativePath('/tmp/default.txt', signal(), { platform: 'darwin' })
    const [command, args, options] = execFileMock.mock.calls[0]!
    expect(command).toBe('open')
    expect(args).toEqual(['/tmp/default.txt'])
    expect(options.encoding).toBe('utf8')
    expect(options.windowsHide).toBe(true)
    expect(options.signal).toBeInstanceOf(AbortSignal)

    const commandError = Object.assign(new Error('open failed'), { code: 1 })
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(commandError, 'partial output', 'failure details')
    })
    await expect(openNativePath('/tmp/missing.txt', signal(), { platform: 'darwin' })).rejects.toMatchObject({
      message: 'open failed', cause: commandError, code: 1,
      stdout: 'partial output', stderr: 'failure details',
    })
  })
})

describe('browser-renderable documents', () => {
  const LS_PLIST = `{
    LSHandlers = (
        {
            LSHandlerPreferredVersions =             {
                LSHandlerRoleAll = "-";
            };
            LSHandlerRoleAll = "com.google.chrome";
            LSHandlerURLScheme = https;
        }
    );
}`

  it('opens a page with the default browser rather than the .html handler on darwin', async () => {
    const calls: { command: string; args: readonly string[] }[] = []
    const run = async (command: string, args: readonly string[]) => {
      calls.push({ command, args })
      return { stdout: command === 'defaults' ? LS_PLIST : '', stderr: '' }
    }
    await openNativePath('/w/page.html', new AbortController().signal, { platform: 'darwin', run })
    // A developer who bound .html to an editor still gets a rendered page.
    expect(calls.map(c => [c.command, ...c.args])).toEqual([
      ['defaults', 'read', 'com.apple.LaunchServices/com.apple.launchservices.secure'],
      ['open', '-b', 'com.google.chrome', '/w/page.html'],
    ])
  })

  it('leaves every other document to the default application', async () => {
    const calls: string[][] = []
    const run = async (command: string, args: readonly string[]) => {
      calls.push([command, ...args])
      return { stdout: '', stderr: '' }
    }
    await openNativePath('/w/report.md', new AbortController().signal, { platform: 'darwin', run })
    // No LaunchServices read at all: markdown is not a browser document.
    expect(calls).toEqual([['open', '/w/report.md']])
  })

  it('falls back to the default application when no browser can be named', async () => {
    // LaunchServices has no https record (a fresh account), so the system's
    // own content-type choice is the best answer available.
    const calls: string[][] = []
    const run = async (command: string, args: readonly string[]) => {
      calls.push([command, ...args])
      if (command === 'defaults') throw new Error('domain not found')
      return { stdout: '', stderr: '' }
    }
    await openNativePath('/w/page.html', new AbortController().signal, { platform: 'darwin', run })
    expect(calls).toEqual([
      ['defaults', 'read', 'com.apple.LaunchServices/com.apple.launchservices.secure'],
      ['open', '/w/page.html'],
    ])

    // A record without an https handler is the same answer.
    const bare: string[][] = []
    await openNativePath('/w/page.html', new AbortController().signal, {
      platform: 'darwin',
      run: async (command, args) => {
        bare.push([command, ...args])
        return { stdout: '{ LSHandlers = ( ); }', stderr: '' }
      },
    })
    expect(bare[1]).toEqual(['open', '/w/page.html'])
  })

  it('honors $BROWSER on linux and leaves windows to its association', async () => {
    const linux: string[][] = []
    await openNativePath('/w/page.html', new AbortController().signal, {
      platform: 'linux',
      env: { BROWSER: 'firefox' },
      run: async (command, args) => { linux.push([command, ...args]); return { stdout: '', stderr: '' } },
    })
    expect(linux).toEqual([['firefox', '/w/page.html']])

    // Unset $BROWSER: xdg-open's association is the fallback.
    const bare: string[][] = []
    await openNativePath('/w/page.html', new AbortController().signal, {
      platform: 'linux',
      env: {},
      run: async (command, args) => { bare.push([command, ...args]); return { stdout: '', stderr: '' } },
    })
    expect(bare).toEqual([['xdg-open', '/w/page.html']])

    // Windows names no browser without the UserChoice registry.
    const win: string[][] = []
    await openNativePath('C:\\w\\page.html', new AbortController().signal, {
      platform: 'win32',
      run: async (command, args) => { win.push([command, ...args]); return { stdout: '', stderr: '' } },
    })
    expect(win[0]?.[0]).toBe('powershell.exe')
  })
})
