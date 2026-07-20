/**
 * Escape probe 1: the repo-convention `./src/*` export channel. It is NOT
 * condition-gated, so a client-program file can deep-import the node half
 * source directly and the augmentation walks in. If this compiles, the
 * channel must be closed on dual-side packages (or gate-covered).
 */
import { createEchoB } from '@dsh-spike/echo-b/src/node.ts'

void createEchoB
