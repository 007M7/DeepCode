/**
 * V1-mainline misuse demo: without the condition scheme, a dual/node package's
 * ordinary "." entry RESOLVES in a client program. No TS error anywhere in
 * this file - the pollution is fully silent (echo-d has no node: imports).
 * Only the gate's symbol tracing catches it: Context.echoD <- echo-d/src/node.ts.
 */
import './client-main.ts'
import { createEchoD } from '@dsh-spike/echo-d'

void createEchoD()
