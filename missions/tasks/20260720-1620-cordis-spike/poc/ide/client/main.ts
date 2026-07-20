/**
 * IDE-story client entry. This directory carries its own tsconfig.json
 * (NO customConditions), so tsserver's nearest-config walk-up binds this
 * file to the client program while ide/node/main.ts binds to the node
 * program — both open in one editor window, no per-file pragmas.
 *
 * Blocking shape depends on the node package's layout:
 * - pure-gate "." (dsh-node only): TS2307 cannot-find-module — loud always.
 * - two-tier "." (default -> runtime lib, no .d.ts): TS7016 under
 *   noImplicitAny. The repo has noImplicitAny on, so production is loud;
 *   THIS PoC compiles vendor src in-program and must relax noImplicitAny,
 *   which silences TS7016 here (PoC artifact, not a production property —
 *   see README "IDE 故事" for the matrix).
 */
import { Context } from 'cordis'
import { applyEchoAClient } from '@dsh-spike/echo-a/client'

import { createEchoB } from '@dsh-spike/echo-b'

const ctx = new Context()
applyEchoAClient(ctx)
void ctx.timer
// @ts-expect-error node-side augmentation invisible in this program
void ctx.sessions
void createEchoB
