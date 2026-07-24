/** Child process competing to reclaim one stale JSONL live-session lease. */

import { access, writeFile } from 'node:fs/promises'
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, gate, marker, rawId] = process.argv.slice(2)
if (root === undefined || gate === undefined || marker === undefined || rawId === undefined) {
  throw new Error('usage: live-lease-race-child.ts <root> <gate> <marker> <session-id>')
}

for (;;) {
  try {
    await access(gate)
    break
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
try {
  await ctx.sessionPersistence.claimLive(SessionId(rawId))
  await writeFile(marker, 'claimed')
  await new Promise<never>(() => { setInterval(() => {}, 60_000) })
} catch (error) {
  await writeFile(marker, `rejected:${error instanceof Error ? error.message : String(error)}`)
  await ctx.fiber.dispose()
}
