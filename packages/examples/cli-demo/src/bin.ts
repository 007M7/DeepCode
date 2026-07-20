#!/usr/bin/env node
/**
 * Process wrapper for `dsh-cli-demo`; covered parsing and task execution live in
 * `cli.ts` while this entry owns Unix signal-to-exit-code mapping.
 * @module @deepseek-ai/dsh-cli-demo/bin
 */

import { installFailLoud } from '@deepseek-ai/dsh-app-boot'
import { executeCli } from './cli.ts'

const NAME = 'dsh-cli-demo'

/* v8 ignore start -- thin self-executing process glue; built-bin tests exercise
   real argv, signals, Loader boot, output, and exit codes */
const abort = new AbortController()
let signalExitCode: number | undefined
const interrupt = (signal: 'SIGINT' | 'SIGTERM', code: number): void => {
  signalExitCode ??= code
  if (!abort.signal.aborted) abort.abort(`received ${signal}`)
}
const onSigint = (): void => { interrupt('SIGINT', 130) }
const onSigterm = (): void => { interrupt('SIGTERM', 143) }
const uninstallFailLoud = installFailLoud(NAME)
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
try {
  const code = await executeCli(process.argv.slice(2), { signal: abort.signal })
  process.exitCode = signalExitCode ?? code
} finally {
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  uninstallFailLoud()
}
/* v8 ignore stop */
