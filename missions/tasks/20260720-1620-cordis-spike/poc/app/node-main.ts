/**
 * Node program entry: node halves imported through the packages' MAIN entries,
 * which resolve because tsconfig.node.json carries customConditions:
 * ["dsh-node"]. `ctx.sessions` / `ctx.echoB` type-check only because their
 * augmentations are in this program — mirror image of the client negatives.
 */
import { Context } from 'cordis'
import { applyEchoANode } from '@dsh-spike/echo-a'
import { createEchoB } from '@dsh-spike/echo-b'

const ctx = new Context()
applyEchoANode(ctx)
void ctx.sessions
void ctx.echoB
void createEchoB('/tmp')
