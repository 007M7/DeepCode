/**
 * `/plugins/events` SSE channel: the system-side push surface for the client
 * entry graph (connect → current graph frame; dev rebuild → rebuilt frame).
 * Presentation-only wire — frames never enter the session log (distinct from
 * the /api/* session SSE, which is api-contract territory). Connections are
 * plain node:http responses held in a set; the server's closeAllConnections
 * tears them down on shutdown.
 */

import type { ServerResponse } from 'node:http'
import type { WebBootGraph } from './web-plugins.ts'

/** One `/plugins/events` frame: the full graph on connect, or one rebuilt bundle notice. */
export type PluginEventFrame =
  | { type: 'graph'; graph: WebBootGraph }
  | { type: 'rebuilt'; id: string; rev: string }

/** Broadcast surface owned by the webserver routing layer. */
export interface PluginEventChannel {
  /** Adopt one incoming SSE request: writes the SSE preamble and the current-graph frame, then keeps the response open. */
  connect(res: ServerResponse, graph: WebBootGraph): void
  /** Push one frame to every open connection. */
  broadcast(frame: PluginEventFrame): void
}

/** Serialize one frame as an SSE data line. */
function sseData(frame: PluginEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/**
 * Create the channel (one per running server).
 * @returns the connect/broadcast surface.
 */
export function createPluginEventChannel(): PluginEventChannel {
  const connections = new Set<ServerResponse>()
  return {
    connect(res, graph) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      })
      // Comment line on open so clients/proxies see a live channel even when
      // no rebuild ever happens; EventSource frame parsing skips it naturally.
      res.write(': connected\n\n')
      res.write(sseData({ type: 'graph', graph }))
      connections.add(res)
      res.on('close', () => { connections.delete(res) })
    },
    broadcast(frame) {
      const line = sseData(frame)
      for (const res of connections) res.write(line)
    },
  }
}
