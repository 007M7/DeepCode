/**
 * The SDK-facing stdio JSON-RPC server plugin: mounting it wires a
 * {@link JsonRpcLineTransport} over the process stdio and serves
 * {@link HarnessSdkServer} (`initialize` → `session/prompt`* → `shutdown`,
 * plus the `session.*`/`subagent.*` notifications) to an out-of-process SDK
 * client (e.g. the Python `deepseek_harness` package). The structured
 * SDK-client analogue of the `acp` bridge: a client-driver plugin over
 * `ctx.agents`, not a loop change and not a capability seam. Which process
 * actually serves this protocol is a `cordis.yml` decision — the tree that
 * loads this plugin IS the SDK server (the `dsh-jsonrpc-agent` bin boots such
 * a tree for the single-exe distribution; see
 * docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
 *
 * stdout is the protocol: this plugin must run in a tree that loads NO stdout
 * logger (the console logger writes to stdout and would corrupt the JSON-RPC
 * frames). The guarantee is config-only — see the package README.
 *
 * Exit-lifecycle split: this plugin owns the PROTOCOL-level exit (the
 * `shutdown` request answers first, then the plugin disposes its own fiber and
 * exits 0 — see {@link apply}); process-level exits (stdin EOF, SIGTERM,
 * SIGINT) belong to the app bin (`dsh-jsonrpc-agent`), which disposes the
 * whole root context.
 *
 * Plugin export shape: named `name`/`inject`/`Config`/`apply`, NO default
 * export — the cordis Loader's `unwrapExports` does `exports.default ??
 * exports`, so a stray default would collapse the module to the bare `apply`
 * and silently drop `inject`/`name`/`Config` (see docs/postmortem/0001).
 *
 * @module @deepseek-ai/dsh-jsonrpc
 */

import type { Context } from 'cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from 'schemastery'
import { HarnessSdkServer } from './server.ts'
import { JsonRpcLineTransport } from './transport.ts'

export * from './server.ts'
export * from './transport.ts'

export const name = 'jsonrpc'
// The server programs against the agent factory only: `agents` is read on
// every `session/prompt` (get-or-create) and on `subagent/end` demux. The LLM
// seam is deliberately NOT injected — `initialize` reads it opportunistically
// via `ctx.get('llm')` (the topology-independent lookup for a non-injected
// service, per packages/AGENTS.md) to decide whether to lazily mount the
// DeepSeek adapter for the requested model.
export const inject = ['agents']

/**
 * Plugin config. Every field is a runtime-only test seam — none is part of the
 * schemastery {@link Config}, so nothing here is settable from a `cordis.yml`
 * (production always serves the process stdio and exits via `process.exit`).
 */
export interface JsonRpcConfig {
  /**
   * Transport input override. Production omits this (the plugin reads
   * `process.stdin`); tests inject an in-memory `Readable` to drive the server
   * without a subprocess.
   */
  input?: Readable
  /**
   * Transport output override. Production omits this (the plugin writes
   * `process.stdout` — the protocol channel); tests inject an in-memory
   * `Writable` to capture frames.
   */
  output?: Writable
  /**
   * Process-exit override for the `shutdown` request path. Production omits
   * this (`process.exit`); tests inject a recorder so a driven shutdown does
   * not kill the test process.
   */
  exit?: (code: number) => void
}

export const Config: Schema<JsonRpcConfig> = Schema.object({})

/**
 * Mount the SDK server on the process stdio: build the line transport and
 * {@link HarnessSdkServer}, dispatch incoming requests, and start reading
 * frames. Disposal is an effect: disposing this plugin's fiber runs
 * `server.shutdown()` (disposes every SDK-created agent to quiescence and
 * detaches the event subscriptions) and `transport.close()`.
 *
 * The `shutdown` request's process-exit semantics live HERE, because the
 * plugin owns the server and transport: the request is answered first, an
 * explicit output-write barrier confirms the response frame flushed, then the
 * plugin disposes its
 * OWN fiber and calls `exit(0)`. Own-fiber disposal is sufficient — the
 * request's `server.shutdown()` already brought every SDK-created agent to
 * quiescence (their session logs are flushed by the awaited agent-handle
 * disposes), the fiber's effect disposer re-runs the idempotent shutdown and
 * closes the transport, and the process exit that follows IS the teardown of
 * the rest of the tree (the bin's EOF/signal handlers own root-context
 * disposal for the process-level exits).
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // Capture the fiber handle NOW, during apply(): the shutdown path runs LATER,
  // from the transport's read loop, and must dispose exactly this plugin's
  // fiber (cf. the injection-scope capture note in the acp bridge).
  const fiber = ctx.fiber
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime seams */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime seams */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- production exit wiring; tests always inject the runtime seams */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessSdkServer(ctx, transport)

  // The shutdown-request exit path, exactly once (a second `shutdown` frame
  // racing the dispose shares the same task). Flush and disposal failures are
  // settled independently: once shutdown was answered, process exit is still
  // the honest outcome and neither failure may prevent the next teardown step.
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => fiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // The transport writes the returned result after this handler resolves.
      // Schedule the explicit flush barrier after that write, then dispose this
      // plugin's fiber and exit 0 (see apply's doc).
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'jsonrpc.serve')
}
