/** Generate the subprocess Code Runtime's dependency-free runner bundle. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'tsdown'

const root = resolve(import.meta.dirname, '..')
const ENTRY = 'packages/code-runtime/code-runtime-subprocess/src/runner.ts'
const OUT = 'packages/code-runtime/code-runtime-subprocess/src/runner-source.generated.ts'

/**
 * Bundle the typed runner and shared worker implementation into one source literal.
 * @returns generated TypeScript module consumed by the subprocess backend.
 */
export async function renderCodeRuntimeRunner(): Promise<string> {
  const bundles = await build({
    config: false,
    entry: [resolve(root, ENTRY)],
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    write: false,
    dts: false,
    clean: false,
    minify: true,
    logLevel: 'silent',
    report: false,
    deps: { alwaysBundle: ['@deepseek-ai/dsh-code-runtime-worker'] },
  })
  try {
    const chunks = bundles.flatMap(bundle => bundle.chunks).filter(chunk => chunk.type === 'chunk')
    if (chunks.length !== 1) throw new Error(`gen-code-runtime-runner: expected one chunk, received ${chunks.length}`)
    const chunk = chunks[0]
    if (chunk === undefined) throw new Error('gen-code-runtime-runner: runner chunk is missing')
    const external = chunk.imports.filter(specifier => !specifier.startsWith('node:'))
    if (external.length > 0) {
      throw new Error(`gen-code-runtime-runner: runner retained external imports: ${external.join(', ')}`)
    }
    return [
      '/**',
      ' * Generated dependency-free execution-world runner.',
      ' * Do not edit by hand; run `pnpm run gen-code-runtime-runner`.',
      ' */',
      '',
      `export const CODE_RUNNER_SOURCE = ${JSON.stringify(chunk.code)}`,
      '',
    ].join('\n')
  } finally {
    await Promise.all(bundles.map(async (bundle) => { await bundle[Symbol.asyncDispose]() }))
  }
}

async function main(): Promise<void> {
  const content = await renderCodeRuntimeRunner()
  const output = resolve(root, OUT)
  if (process.argv.includes('--check')) {
    const committed = existsSync(output) ? readFileSync(output, 'utf8') : null
    if (committed === content) {
      console.log(`gen-code-runtime-runner: ${OUT} is up to date.`)
      return
    }
    console.error(`gen-code-runtime-runner: ${OUT} is stale. Run \`pnpm run gen-code-runtime-runner\` and commit it.`)
    process.exitCode = 1
    return
  }
  writeFileSync(output, content)
  console.log(`gen-code-runtime-runner: wrote ${OUT}.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) await main()
