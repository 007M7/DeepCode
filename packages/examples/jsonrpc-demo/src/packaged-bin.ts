#!/usr/bin/env node
/**
 * Closed-runtime JSON-RPC agent bin. Bare plugins resolve from the installed
 * runtime closure while relative plugins remain configuration-relative.
 *
 * @module @deepseek-ai/dsh-jsonrpc-demo/packaged-bin
 */

import { runJsonrpcAgent } from './runner.ts'

await runJsonrpcAgent(import.meta.url)
