/**
 * The customConditions interception positive: a client-program file importing
 * node halves through the packages' MAIN entries. Standalone program (no
 * vendor src) so noImplicitAny can stay ON like the production repo.
 * Expected under tsconfig.client-violation.json (no "dsh-node" condition):
 * - echo-b (two-tier ".": default -> runtime lib, no .d.ts): TS7016 —
 *   declaration file not found, loud at the import site under noImplicitAny.
 * - echo-a (pure-gate ".": dsh-node only): TS2307 — cannot find module.
 * Both config-native, in tsc and IDE alike, no gate involved.
 */
// @ts-expect-error TS7016: echo-b's types resolve only under dsh-node
import { createEchoB } from '@dsh-spike/echo-b'
// @ts-expect-error TS2307: echo-a's '.' resolves only under dsh-node
import { applyEchoANode } from '@dsh-spike/echo-a'

void createEchoB
void applyEchoANode
