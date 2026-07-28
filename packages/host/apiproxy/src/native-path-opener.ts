/** Cross-platform open-with-default-application used by the local GUI carrier. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'

/** Testable command boundary; native implementations never invoke a shell. */
export type PathOpenerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface PathOpenerInternals {
  platform?: NodeJS.Platform
  run?: PathOpenerRunner
}

/** PowerShell single-quoted literal (doubles embedded quotes). */
function powershellLiteral(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/**
 * Open a filesystem path with the operating system's default application.
 * @param path - absolute or host-resolvable path (caller owns resolution).
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - platform and runner seam for deterministic tests.
 */
export async function openNativePath(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    await run('open', [path], signal)
    return
  }

  if (platform === 'win32') {
    await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Invoke-Item -LiteralPath ${powershellLiteral(path)}`,
    ], signal)
    return
  }

  if (platform === 'linux') {
    await run('xdg-open', [path], signal)
    return
  }

  throw new Error(`native path opener is unsupported on ${platform}`)
}
