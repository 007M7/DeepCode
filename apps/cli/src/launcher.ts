/**
 * Shared execution path for the `dsh` and `deepseek` command names. Keeping
 * dispatch here makes both bins boot the same profile implementation.
 * @module @deepseek-ai/dsh/launcher
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import type { DshInvocation } from './args.ts'

/**
 * Read this installed app's version from its package manifest.
 * @returns The version printed by both executable names.
 */
export function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/**
 * Execute one already-parsed launcher invocation.
 * @param invocation - profile, plugin, or config-dump operation to run.
 */
export async function runInvocation(invocation: DshInvocation): Promise<void> {
  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      await runProfile({
        environment: loadLayeredEnv('dsh'),
        profile: invocation.profile,
        patchFiles: invocation.patches,
        args: invocation.args,
      })
      return
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(runPlugin(invocation.profile, invocation.args))
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
      return
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}
