// Webserver bridge backpressure probe (audit R2, webserver half): a paused client socket
// must stall the SSE pump (res.write false → await drain) instead of buffering unboundedly.
// Self-contained: starts startWebServer on PORT with a stub apiHandler; no host needed.
// Run: node_modules/.bin/tsx missions/scripts/verify-webserver-backpressure.mjs
import { connect } from 'node:net'
import { once } from 'node:events'
import { startWebServer } from '../../packages/host/webserver/src/index.ts'

const PORT = Number(process.env.PROBE_PORT ?? 3097)
const CHUNK = 64 * 1024
const TOTAL = 200 // 200 × 64KB = 12.5MB — far beyond any socket buffer
let failures = 0
const report = (n, p, d = '') => { failures += p ? 0 : 1; console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

let pulled = 0
const apiHandler = {
  fetch: async () => new Response(new ReadableStream({
    pull(controller) {
      if (pulled >= TOTAL) return controller.close()
      pulled++
      controller.enqueue(new Uint8Array(CHUNK))
    },
  }), { headers: { 'content-type': 'text/event-stream' } }),
}

const server = await startWebServer({ port: PORT, distIndex: '/nonexistent/index.html', apiHandler }, (e) => console.error(String(e)))
const socket = connect(PORT, '127.0.0.1')
await once(socket, 'connect')
socket.write(`GET /api/events.host HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`)
socket.pause() // stop reading: kernel+node buffers fill, then res.write must return false

await new Promise(r => setTimeout(r, 1500))
const stalled = pulled
// Without drain-await the pump races through all chunks regardless of the paused reader.
report('R2 暂停读的慢客户端使泵停在低水位（非全量吞入内存）', stalled < TOTAL / 2, `pulled=${stalled}/${TOTAL}`)

socket.resume() // drain: the pump must resume and finish
const t0 = Date.now()
while (pulled < TOTAL && Date.now() - t0 < 10_000) await new Promise(r => setTimeout(r, 100))
report('R2b 恢复读后泵继续推进到完成', pulled === TOTAL, `pulled=${pulled}/${TOTAL}`)

socket.destroy()
await server.close()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
