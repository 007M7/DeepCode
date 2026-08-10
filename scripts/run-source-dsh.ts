/**
 * Source-checkout launcher. Successful build output stays out of CLI stdout;
 * build failures report their captured diagnostics on stderr before exiting.
 */
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { execa } from 'execa'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceBin = fileURLToPath(new URL('../apps/cli/src/bin.ts', import.meta.url))

function completeFrom(result: { readonly exitCode?: number; readonly signal?: string }): void {
  if (result.signal !== undefined) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.exitCode ?? 1
}

function reportBuildFailure(result: {
  readonly all: string | undefined
  readonly shortMessage: string | undefined
}): void {
  const diagnostic = result.all === undefined || result.all.length === 0
    ? result.shortMessage ?? 'Source build failed without diagnostics.'
    : result.all
  process.stderr.write(diagnostic.endsWith('\n') ? diagnostic : `${diagnostic}\n`)
}

const build = await execa('pnpm', ['run', 'build'], {
  all: true,
  cwd: repoRoot,
  reject: false,
  stripFinalNewline: false,
})
if (build.failed) {
  reportBuildFailure(build)
  completeFrom(build)
} else {
  const cli = await execa(process.execPath, ['--import', 'tsx/esm', sourceBin, ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    reject: false,
    stdio: 'inherit',
  })
  completeFrom(cli)
}
