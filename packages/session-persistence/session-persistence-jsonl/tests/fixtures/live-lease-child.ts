/** Child process that holds one JSONL live-session lease until it is killed. */

import { writeFile } from 'node:fs/promises'
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, marker] = process.argv.slice(2)
if (root === undefined || marker === undefined) throw new Error('usage: live-lease-child.ts <root> <marker>')

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SessionPersistenceJsonl, { root, compression: 'none' })
await ctx.sessionPersistence.claimLive(SessionId('leased-session'))
await writeFile(marker, 'held')
await new Promise<never>(() => { setInterval(() => {}, 60_000) })
