/**
 * Node 22 startup-output smoke for first-search SQLite opening.
 *
 * The isolated subprocess omits NODE_OPTIONS so warning suppression cannot
 * hide a static node:sqlite import.
 */

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '../../../..')

it('mounts and disposes first-search mode without a SQLite experimental warning', async () => {
  const script = `
    import { Context } from 'cordis'
    import SessionStore from '@deepseek-ai/dsh-session'
    import SessionQuerySqlite from './packages/session-query/session-query-sqlite/src/index.ts'

    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const search = await ctx.plugin(SessionQuerySqlite, {
      path: ':memory:',
      openAt: 'first-search',
    })
    await search.dispose()
    await sessions.dispose()
  `
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const { stderr } = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
  ], {
    cwd: root,
    env,
  })

  expect(stderr).not.toMatch(/ExperimentalWarning: SQLite/)
})
