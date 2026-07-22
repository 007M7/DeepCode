/**
 * `dsh -p "task"` — the headless assembly: startHost + in-process isomorphic
 * injection (InProcessApiClient over the host handler, so the full carrier
 * chain — wire serialization, zod, SSE framing — really runs; this is the
 * protocol's second real consumer). No HTTP server, no port, no dist
 * resolution. Runs one task turn, prints the final assistant text, exits
 * (completed → 0, else 1).
 */

import { parseArgs } from 'node:util'
import { startHost } from '@deepseek-ai/dsh-host-runtime'
import { InProcessApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Outcome of one headless turn: aggregated final text plus the turn-end reason kind. */
interface TurnOutcome {
  text: string
  reason: string
}

/** Unwrap an RpcResponse or fail loud: business errors print and exit 1 (dispose first). */
async function unwrap<T>(response: RpcResponse<T>, dispose: () => Promise<void>): Promise<T> {
  if (response.result.ok) return response.result.value
  const { code, message } = response.result.error
  process.stderr.write(`dsh: ${code}: ${message}\n`)
  await dispose()
  process.exit(1)
}

/**
 * Consume mux frames until the task turn ends, per the cli-demo runOneShot
 * correlation precedent: anchor on the first turn/start whose trigger kind is
 * 'message' (startup-injected turns are skipped), aggregate text from that
 * turn's assistant/message events (last one wins), finish on its turn/end.
 */
async function consumeUntilTurnEnd(frames: AsyncIterable<RpcRequest<MuxFrame>>, sessionId: SessionId): Promise<TurnOutcome> {
  let targetTurn: number | undefined
  let text = ''
  try {
    for await (const frame of frames) {
      const payload = frame.payload
      if (payload.type === 'stream/error') {
        process.stderr.write(`dsh: stream error: ${payload.error.message}\n`)
        return { text, reason: 'error' }
      }
      if (payload.type !== 'session/event' || payload.sessionId !== sessionId) continue
      const event = payload.event
      if (targetTurn === undefined) {
        if (event.type === 'turn/start' && event.data.trigger.kind === 'message') targetTurn = event.data.turn
        continue
      }
      if (event.type === 'assistant/message' && event.data.turn === targetTurn) {
        const joined = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (joined !== '') text = joined
      }
      if (event.type === 'turn/end' && event.data.turn === targetTurn) {
        return { text, reason: event.data.reason.kind }
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh: event stream failed: ${String(error)}\n`)
  }
  return { text, reason: 'error' }
}

export async function runHeadless(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { prompt: { type: 'string', short: 'p' } },
    allowPositionals: false,
  })
  const task = values.prompt
  if (task === undefined || task === '') {
    process.stderr.write('usage: dsh -p "task"\n')
    process.exit(1)
  }

  // A missing DEEPSEEK_API_KEY throws here (plugin load is fail-loud, uncaught by design).
  const host = await startHost({ boot: { persistenceRoot: './.sessions' } })
  const api = new InProcessApiClient(host.handler)

  const created = await unwrap(await api.sessions.create({}), host.dispose)

  // Open the stream before prompting so no frame is lost — kept in this order
  // even though in-process delivery has no race, so the code survives a move
  // to a remote HTTP carrier unchanged.
  const abort = new AbortController()
  const frames = api.events.mux({}, abort.signal)
  const done = consumeUntilTurnEnd(frames, created.sessionId)

  await unwrap(await api.sessions.prompt({
    sessionId: created.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: task }],
  }), host.dispose)

  const outcome = await done
  process.stdout.write(outcome.text + '\n')
  abort.abort()
  await host.dispose()
  process.exit(outcome.reason === 'completed' ? 0 : 1)
}
