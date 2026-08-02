/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { pickWin32Directory } from './win32-dialog.ts'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Directory`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === 'string' ? stderr : ''
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - platform and runner seam for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    try {
      const result = await run('osascript', [
        '-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"',
        '-e', 'POSIX path of selectedFolder',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      if (!signal.aborted && errorCode(error) === 1
        && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
      throw error
    }
  }

  if (platform === 'win32') {
    // Primary: the in-process koffi-backed IFileOpenDialog worker — the modern
    // picker with per-monitor-v2 DPI, no PowerShell dependency, and abort
    // support. Any non-abort failure (koffi unavailable, ancient Windows, COM
    // refusal) falls back to the PowerShell chain below.
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
    try {
      return await pickDialog(signal)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
    }

    // PowerShell fallback: PowerShell 7 renders the modern IFileDialog folder
    // picker, while Windows PowerShell 5.1's FolderBrowserDialog is hardwired
    // to the legacy SHBrowseForFolder tree. Prefer pwsh, but ANY pwsh failure
    // falls back to 5.1 (which every Windows ships): a resolvable pwsh can
    // still be unable to deliver the dialog — PowerShell 6 has no WinForms,
    // so its Add-Type exits 1, not ENOENT. Both hosts spawn DPI-unaware, so
    // the script opts the process into system DPI awareness before any window
    // is created. No Description is set: the modern dialog renders it as a
    // bottom strip and the classic dialog as an unthemed box.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DpiAware { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
      '[DpiAware]::SetProcessDPIAware() | Out-Null',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.ShowNewFolderButton = $true',
      '$result = $dialog.ShowDialog()',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '  [Console]::WriteLine($dialog.SelectedPath)',
      '}',
    ].join('; ')
    try {
      const result = await run('pwsh.exe', ['-NoProfile', '-STA', '-Command', script], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
    }
    const result = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], signal)
    return outputPath(result.stdout)
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', '--title=Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', 'Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native directory picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}
