/** Cross-platform native path and text-document openers used by the local GUI carrier. */

import { release as osRelease } from 'node:os'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'

/** Testable command boundary; native implementations never invoke a shell. */
export type PathOpenerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface PathOpenerInternals {
  platform?: NodeJS.Platform
  /** Kernel release override used to distinguish WSL from desktop Linux. */
  osRelease?: string
  /** WSL environment marker override used with the kernel release. */
  env?: Readonly<Partial<Record<'WSL_DISTRO_NAME' | 'WSL_INTEROP', string>>>
  run?: PathOpenerRunner
}

/** Native path-open intent; macOS distinguishes text editing from file association. */
type PathOpenIntent = 'default' | 'text-editor'

/** PowerShell single-quoted literal (doubles embedded quotes). */
function powershellLiteral(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/** Whether one environment marker is set to a non-empty value. */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/** Distinguish WSL from desktop Linux using its process and kernel markers. */
function isWsl(internals: PathOpenerInternals): boolean {
  const env = internals.env ?? process.env
  if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true
  return (internals.osRelease ?? osRelease()).toLowerCase().includes('microsoft')
}

/** Open one Windows-resolvable path through its registered desktop application. */
async function openWindowsPath(path: string, signal: AbortSignal, run: PathOpenerRunner): Promise<void> {
  await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Invoke-Item -LiteralPath ${powershellLiteral(path)}`,
  ], signal)
}

/** Translate a WSL path before handing it to the Windows desktop. */
async function openWslPath(path: string, signal: AbortSignal, run: PathOpenerRunner): Promise<void> {
  const translated = await run('wslpath', ['-w', path], signal)
  signal.throwIfAborted()
  const windowsPath = translated.stdout.replace(/[\r\n]+$/, '')
  if (windowsPath === '') throw new Error('wslpath returned no Windows path')
  await openWindowsPath(windowsPath, signal, run)
}

/** Dispatch one shell-free platform command for the requested open intent. */
async function openNativePathWithIntent(
  path: string,
  signal: AbortSignal,
  intent: PathOpenIntent,
  internals: PathOpenerInternals = {},
): Promise<void> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    await run('open', intent === 'text-editor' ? ['-t', path] : [path], signal)
    return
  }

  if (platform === 'win32') {
    await openWindowsPath(path, signal, run)
    return
  }

  if (platform === 'linux') {
    if (isWsl(internals)) {
      await openWslPath(path, signal, run)
      return
    }
    await run('xdg-open', [path], signal)
    return
  }

  throw new Error(`native path opener is unsupported on ${platform}`)
}

/**
 * Open a filesystem path with the operating system's default application.
 * @param path - absolute or host-resolvable path (caller owns resolution).
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - platform and runner seam for deterministic tests.
 */
export function openNativePath(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'default', internals)
}

/**
 * Open a text document for editing; macOS bypasses the file-type association
 * so a YAML association with a browser cannot consume the gesture.
 * @param path - absolute or host-resolvable text-document path.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - platform and runner seam for deterministic tests.
 */
export function openNativeTextFile(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'text-editor', internals)
}
