/**
 * Concurrency-test driver: register one session in a real separate process,
 * report readiness on stdout, then stay alive until the parent closes stdin.
 *
 * Staying alive is load-bearing. The registry prunes records whose process is
 * gone, so a driver that exited after writing would be pruned by the next
 * writer — the test would then measure pruning instead of the concurrent
 * read-modify-write it exists to cover. Argv: `<root> <sessionId>`.
 */

import { Context } from 'cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionRegistryFile from '@deepseek-ai/dsh-session-registry-file'

const [root, sessionId] = process.argv.slice(2)
if (root === undefined || sessionId === undefined) throw new Error('usage: register-once <root> <sessionId>')

const ctx = new Context()
await ctx.plugin(SessionRegistryFile, { root, lockStaleMs: 10_000, lockRetries: 60 })
await ctx.sessionRegistry.register({ sessionId: SessionId(sessionId), cwd: process.cwd() })
process.stdout.write('registered\n')

// Hold the process open so its record stays live; the parent ends the run by
// closing stdin, and never disposes the fiber, so no deregistration races the
// parent's read.
process.stdin.resume()
process.stdin.on('end', () => { process.exit(0) })
