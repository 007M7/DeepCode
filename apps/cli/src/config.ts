/**
 * Raw `dsh --config <path>` boot: apply one required patch-list overlay over
 * the shipped base config, then leave process lifetime to the mounted plugins.
 * @module @deepseek-ai/dsh/config
 */

import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import {
  boot,
  installFailLoud,
  loadOverlayPatches,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot'
import { DSH_ENVIRONMENT_KEY, type EnvironmentSnapshot } from '@deepseek-ai/dsh-environment'
import { configHasTelemetryRow, resolveTelemetryPatch } from './app-cli-entry.ts'

const NAME = 'dsh'
const BASE_CONFIG = fileURLToPath(new URL('../config/base.cordis.yml', import.meta.url))

/* v8 ignore start -- the source-launch and built-bin acceptance paths own executable dispatch */
/**
 * Boot the shipped base with one explicit overlay.
 * @param environment - this run's frozen environment snapshot, provided to the
 * tree before any config entry mounts.
 * @param config - required patch-list path parsed from `--config`.
 */
export async function runConfig(environment: EnvironmentSnapshot, config: string): Promise<void> {
  const app: { current?: Context } = {}
  let exiting = false
  const shutdown = (code: number): void => {
    if (exiting) return
    exiting = true
    void Promise.resolve(app.current?.fiber.dispose()).finally(() => { process.exit(code) })
  }
  // An inserted front door can publish readiness before sibling rows finish
  // mounting. Signals must own teardown throughout that startup window, not
  // only after boot() settles.
  process.on('SIGTERM', () => { shutdown(0) })
  process.on('SIGINT', () => { shutdown(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })
  const overlay = resolveConfigPath(config, undefined)
  const telemetryPatch = resolveTelemetryPatch(
    process.env.DSH_TELEMETRY_DISABLED,
    configHasTelemetryRow(BASE_CONFIG),
  )
  const ctx = await boot(NAME, BASE_CONFIG, [
    ...loadOverlayPatches(NAME, overlay),
    ...telemetryPatch === undefined ? [] : [telemetryPatch],
  ], (hostCtx) => {
    // Before any config-tree entry mounts, so a plugin that resolves a
    // user-facing value at construction already sees this run's layers.
    hostCtx.provide(DSH_ENVIRONMENT_KEY, environment)
    app.current = hostCtx
  })
  app.current = ctx
}
/* v8 ignore stop */
