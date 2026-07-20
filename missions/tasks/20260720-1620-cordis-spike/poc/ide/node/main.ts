/**
 * IDE-story node entry. This directory's tsconfig.json carries
 * customConditions: ["dsh-node"], so the same specifiers the client program
 * rejects resolve fine here — tsserver binds this file to the node program
 * by the nearest-config rule, no per-file pragmas.
 */
import { Context } from 'cordis'
import { applyEchoANode } from '@dsh-spike/echo-a'
import { createEchoB } from '@dsh-spike/echo-b'

const ctx = new Context()
applyEchoANode(ctx)
void ctx.sessions
void ctx.echoB
void createEchoB('/tmp')
