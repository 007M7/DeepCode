/**
 * Clean client program entry. The file set is this file's transitive closure:
 * cordis + cosmokit + timer + echo-a client/shared + dsh-brand. Package
 * imports resolve through poc/node_modules symlinks, i.e. REAL exports
 * resolution — no paths shortcut for @dsh-spike/*.
 */
import { Context } from 'cordis'
import { applyEchoAClient } from '@dsh-spike/echo-a/client'
import type { EchoARpc, EchoRequestId } from '@dsh-spike/echo-a/shared'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { assertNodeMergesInvisible } from './negative.ts'

const ctx = new Context()
const method: keyof EchoARpc = applyEchoAClient(ctx)
void method

// Type-only use of clean packages introduces no augmentation.
type LocalProbe = Branded<'spike.local-probe'>
const idProbe: EchoRequestId | LocalProbe | undefined = undefined
void idProbe

assertNodeMergesInvisible(ctx)
