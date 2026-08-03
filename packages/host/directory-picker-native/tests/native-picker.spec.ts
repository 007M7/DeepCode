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
import { pickNativeDirectory, type DirectoryPickerRunner } from '../src/native-picker.ts'

function failure(code: string | number, stderr = ''): Error {
  return Object.assign(new Error(`command failed: ${String(code)}`), { code, stderr })
}

const signal = () => new AbortController().signal

/** The PowerShell chain is reachable only when the in-process dialog fails. */
const noDialog = async (): Promise<string | null> => { throw new Error('dialog unavailable') }

describe('native directory picker', () => {
  it('uses the macOS folder chooser and maps user cancellation to null', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/Users/test/project/\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBe('/Users/test/project/')
    expect(run).toHaveBeenCalledWith('osascript', expect.arrayContaining(['POSIX path of selectedFolder']), expect.any(AbortSignal))

    run.mockRejectedValueOnce(failure(1, 'execution error: User canceled. (-128)'))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBeNull()

    run.mockRejectedValueOnce(failure(2, 'permission denied'))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).rejects.toThrow('command failed')
  })

  it.each([
    ['a primitive error', 'failed'],
    ['an invalid code type', { code: true }],
    ['a missing stderr property', { code: 1 }],
    ['a non-string stderr property', { code: 1, stderr: 42 }],
  ])('does not mistake %s for macOS cancellation', async (_label, reason) => {
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw reason })
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).rejects.toBe(reason)
  })

  it('prefers the in-process Win32 dialog and never spawns PowerShell when it answers', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
    const pickWin32Dialog = vi.fn(async (): Promise<string | null> => 'C:\\work\\selected')
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog })).resolves.toBe('C:\\work\\selected')
    pickWin32Dialog.mockResolvedValueOnce(null)
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog })).resolves.toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back to pwsh when the dialog is unavailable and maps empty output to cancellation', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: 'C:\\work\\project\r\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog: noDialog })).resolves.toBe('C:\\work\\project')
    expect(run).toHaveBeenCalledWith(
      'pwsh.exe',
      expect.arrayContaining(['-NoProfile', '-STA', '-Command']),
      expect.any(AbortSignal),
    )
    const script = run.mock.calls[0]?.[1].at(-1)
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain('SetProcessDPIAware')
    // Description renders as a bottom strip (modern) / unthemed box (classic); never set it.
    expect(script).not.toContain('Description')
    run.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog: noDialog })).resolves.toBeNull()
  })

  it('falls back to Windows PowerShell 5.1 whenever pwsh cannot deliver the dialog', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockResolvedValueOnce({ stdout: 'C:\\work\\fallback\r\n', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog: noDialog })).resolves.toBe('C:\\work\\fallback')
    expect(run.mock.calls.map(call => call[0])).toEqual(['pwsh.exe', 'powershell.exe'])
    // Both runtimes execute the identical script, so DPI awareness holds either way.
    expect(run.mock.calls[0]?.[1].at(-1)).toBe(run.mock.calls[1]?.[1].at(-1))

    // A resolvable pwsh that cannot deliver the dialog (PowerShell 6: no
    // WinForms, Add-Type exits 1 - not ENOENT) reaches 5.1 all the same.
    const pwsh6 = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure(1, "Cannot load assembly 'System.Windows.Forms'"))
      .mockResolvedValueOnce({ stdout: 'C:\\work\\legacy\r\n', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run: pwsh6, pickWin32Dialog: noDialog })).resolves.toBe('C:\\work\\legacy')
    expect(pwsh6.mock.calls.map(call => call[0])).toEqual(['pwsh.exe', 'powershell.exe'])

    const cancelled = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run: cancelled, pickWin32Dialog: noDialog })).resolves.toBeNull()

    // Triple miss: the surfaced AggregateError carries all three causes,
    // including the otherwise-lost in-process dialog failure.
    const failed = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockRejectedValueOnce(failure(2))
    const tripleMiss = await pickNativeDirectory(signal(), { platform: 'win32', run: failed, pickWin32Dialog: noDialog })
      .then(() => { throw new Error('expected rejection') }, (error: unknown) => error as AggregateError)
    expect(tripleMiss.message).toContain('the in-process dialog and both PowerShell hosts failed')
    expect((tripleMiss.errors[0] as Error).message).toBe('dialog unavailable')
    expect((tripleMiss.errors[2] as Error).message).toContain('command failed')
  })

  it('wires the real Win32 dialog as the default tier', async () => {
    // A pre-aborted signal makes the DEFAULT dialog deterministic on every
    // host: pickWin32Directory throws before spawning any worker or window.
    const abort = new AbortController()
    abort.abort()
    const run = vi.fn<DirectoryPickerRunner>()
    await expect(pickNativeDirectory(abort.signal, { platform: 'win32', run }))
      .rejects.toThrow('native directory picker aborted')
    expect(run).not.toHaveBeenCalled()
  })

  it('does not fall back when the caller aborted the dialog or the pwsh spawn', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const run = vi.fn<DirectoryPickerRunner>()
    await expect(pickNativeDirectory(abort.signal, { platform: 'win32', run, pickWin32Dialog: noDialog })).rejects.toThrow('dialog unavailable')
    expect(run).not.toHaveBeenCalled()

    const liveThenAborted = new AbortController()
    const abortingRun = vi.fn<DirectoryPickerRunner>(async () => {
      liveThenAborted.abort(new Error('closed'))
      throw failure('ENOENT')
    })
    await expect(pickNativeDirectory(liveThenAborted.signal, { platform: 'win32', run: abortingRun, pickWin32Dialog: noDialog }))
      .rejects.toThrow('command failed')
    expect(abortingRun).toHaveBeenCalledOnce()
  })

  it('runs the default command adapter without a shell and preserves command failures', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, 'C:\\work\\default\r\n', '')
    })
    await expect(pickNativeDirectory(signal(), { platform: 'win32', pickWin32Dialog: noDialog })).resolves.toBe('C:\\work\\default')
    const [command, args, options] = execFileMock.mock.calls[0]!
    expect(command).toBe('pwsh.exe')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-STA', '-Command']))
    expect(options.encoding).toBe('utf8')
    expect(options.windowsHide).toBe(true)
    expect(options.signal).toBeInstanceOf(AbortSignal)

    // Both chain tiers fail: pwsh's code-7 failure now reaches 5.1, whose
    // failure is the one the caller sees.
    const pwshError = Object.assign(new Error('pwsh failed'), { code: 7 })
    const commandError = Object.assign(new Error('powershell failed'), { code: 7 })
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(pwshError, '', 'no WinForms')
    })
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(commandError, 'partial output', 'failure details')
    })
    const surfaced = await pickNativeDirectory(signal(), { platform: 'win32', pickWin32Dialog: noDialog })
      .then(() => { throw new Error('expected rejection') }, (error: unknown) => error as AggregateError)
    expect(surfaced.errors[2]).toMatchObject({
      message: 'powershell failed', cause: commandError, code: 7,
      stdout: 'partial output', stderr: 'failure details',
    })
    expect(execFileMock.mock.calls.map(call => call[0])).toEqual(['pwsh.exe', 'pwsh.exe', 'powershell.exe'])
  })

  it('uses the current process platform when no platform override is supplied', async () => {
    // Deterministic on every host: the win32 tier answers from the dialog,
    // the POSIX tiers from the command runner.
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/default/platform\n', stderr: '' }))
    const pickWin32Dialog = async (): Promise<string | null> => 'C:\\default\\platform'
    const expected = process.platform === 'win32' ? 'C:\\default\\platform' : '/default/platform'
    await expect(pickNativeDirectory(signal(), { run, pickWin32Dialog })).resolves.toBe(expected)
  })

  it('uses Zenity on Linux and falls back to KDialog only when Zenity is missing', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockResolvedValueOnce({ stdout: '/home/test/project\n', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run })).resolves.toBe('/home/test/project')
    expect(run.mock.calls.map(call => call[0])).toEqual(['zenity', 'kdialog'])

    const zenity = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/home/test/direct\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: zenity }))
      .resolves.toBe('/home/test/direct')
    expect(zenity).toHaveBeenCalledOnce()
  })

  it('maps Linux cancellation to null and reports a missing desktop picker', async () => {
    const cancelled = vi.fn<DirectoryPickerRunner>(async () => { throw failure(1) })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: cancelled })).resolves.toBeNull()

    const missing = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ENOENT') })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: missing }))
      .rejects.toThrow('install zenity or kdialog')

    const kdialogCancelled = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockRejectedValueOnce(failure(1))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: kdialogCancelled }))
      .resolves.toBeNull()

    const zenityFailed = vi.fn<DirectoryPickerRunner>(async () => { throw failure(2) })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: zenityFailed }))
      .rejects.toThrow('command failed')

    const kdialogFailed = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockRejectedValueOnce(failure(2))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: kdialogFailed }))
      .rejects.toThrow('command failed')
  })

  it('does not convert caller aborts into user cancellation', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ABORT_ERR') })
    await expect(pickNativeDirectory(abort.signal, { platform: 'linux', run })).rejects.toThrow('command failed')
  })

  it('reports unsupported platforms', async () => {
    await expect(pickNativeDirectory(signal(), { platform: 'aix' })).rejects.toThrow('unsupported on aix')
  })
})
