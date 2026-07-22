#!/usr/bin/env node
/** Test driver that sends two turns through one Headless Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runOneShot } from '@deepseek-ai/dsh-cli-demo/src/cli.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('time-context driver requires a config path')

const ctx = await boot('time-context-e2e', resolveConfigPath(configPath, undefined))
try {
  await runOneShot(ctx, { task: 'first' })
  await runOneShot(ctx, { task: 'second' })
} finally {
  await ctx.fiber.dispose()
}
