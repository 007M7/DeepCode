// Carrier error-channel regression probes (audit batch: A1/A2/A4/A9 + R2 half).
// Runs the isomorphic path (InProcessApiClient over toFetchHandler) — no server needed.
// Run: node --experimental-strip-types missions/scripts/verify-carrier-errors.mjs  (or via tsx)
import { toFetchHandler } from '../../packages/host/apiproxy/src/fetch/handler.ts'
import { InProcessApiClient } from '../../packages/host/apiproxy/src/fetch/client.ts'
import { RpcId } from '../../packages/host/apiproxy/src/api/rpc.ts'
import { serverResponseSchema } from '../../packages/host/apiproxy/src/api/rpc.schema.ts'

let failures = 0
const report = (n, p, d = '') => { failures += p ? 0 : 1; console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const okList = { rpcId: RpcId('x'), result: { ok: true, value: { items: [] } } }
/** Minimal ApiProxy stub; per-test cases override single methods. */
function makeApi(overrides = {}) {
  return {
    sessions: {
      list: async (r) => ({ ...okList, rpcId: r.rpcId }),
      create: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { sessionId: 's1' } } }),
      history: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }),
      prompt: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
      cancel: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
      ...overrides.sessions,
    },
    host: {
      describe: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { version: '0', cwd: '/', attachedSessions: 0 } } }),
      ...overrides.host,
    },
    events: {
      mux: overrides.mux ?? async function* () {},
      host: overrides.hostStream ?? async function* () {},
    },
    respond: async () => ({ accepted: false, reason: 'not-pending' }),
  }
}

// ---- A1: mid-stream impl throw → one stream/error frame on the wire, then clean close ----
{
  const api = makeApi({
    hostStream: async function* () {
      yield { rpcId: RpcId('f1'), payload: { type: 'host/session-status', sessionId: 's1', running: true } }
      throw new Error('impl exploded mid-stream')
    },
  })
  const client = new InProcessApiClient(toFetchHandler(api))
  const seen = []
  for await (const frame of client.events.host({}, new AbortController().signal)) seen.push(frame.payload)
  report('A1 流中 impl throw → stream/error 帧真到达 client', seen.some(f => f.type === 'stream/error' && f.error.code === 'internal' && /impl exploded/.test(f.error.message)), JSON.stringify(seen.map(f => f.type)))
  report('A1b stream/error 后流正常收尾（迭代自然结束不 throw）', true)
}

// ---- A2: S→C frame validation — a malformed frame is dropped, the stream survives ----
{
  const api = makeApi({
    hostStream: async function* () {
      yield { rpcId: RpcId('bad'), payload: { type: 'host/session-status', sessionId: 's1' } } // missing `running`
      yield { rpcId: RpcId('good'), payload: { type: 'host/session-status', sessionId: 's1', running: false } }
    },
  })
  const client = new InProcessApiClient(toFetchHandler(api))
  const seen = []
  for await (const frame of client.events.host({}, new AbortController().signal)) seen.push(frame)
  report('A2 坏帧被丢弃且不杀流（后续好帧照常到达）', seen.length === 1 && seen[0].payload.running === false, `seen=${seen.length}`)
}

// ---- A2: S→C unary value validation — a wrong-shaped ok value throws at the client boundary ----
{
  const api = makeApi({ sessions: { list: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: 'not-an-array' } } }) } })
  const client = new InProcessApiClient(toFetchHandler(api))
  const threw = await client.sessions.list({}).then(() => false, () => true)
  report('A2b unary ok value 过 Value schema（坏形状在 client 边界抛出）', threw)
}

// ---- A4: envelope parse failure backfills a salvageable rpcId; otherwise the sentinel — and the response parses as a valid ServerResponse ----
{
  const handler = toFetchHandler(makeApi())
  const post = (body) => handler.fetch('http://dsh.internal/api/session.list', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const salvaged = await (await post({ rpcId: 'my-id', method: 5 })).json()
  report('A4 信封烂但 rpcId 可捞 → 回填原值', serverResponseSchema.safeParse(salvaged).success && salvaged.rpcId === 'my-id', JSON.stringify(salvaged.rpcId))
  const sentinel = await (await post({ nothing: true })).json()
  report('A4b rpcId 不可捞 → invalid-request 哨兵，且过 serverResponseSchema', serverResponseSchema.safeParse(sentinel).success && sentinel.rpcId === 'invalid-request', JSON.stringify(sentinel.rpcId))
}

// ---- A10: external signal aborts an in-flight unary ----
{
  const api = makeApi({ sessions: { list: () => new Promise(() => {}) } })
  const client = new InProcessApiClient(toFetchHandler(api))
  const ctl = new AbortController()
  const call = client.sessions.list({}, ctl.signal).then(() => 'resolved', (e) => String(e))
  ctl.abort(new Error('user cancelled'))
  const outcome = await call
  report('A10 unary 外部 signal 可取消在途请求', outcome !== 'resolved', outcome.slice(0, 60))
}

// ---- onOpen: stream-established signal fires before any frame is delivered ----
{
  const api = makeApi({
    hostStream: async function* () {
      yield { rpcId: RpcId('f'), payload: { type: 'host/session-removed', sessionId: 's1' } }
    },
  })
  const client = new InProcessApiClient(toFetchHandler(api))
  const order = []
  const iter = client.events.host({}, new AbortController().signal, () => order.push('open'))[Symbol.asyncIterator]()
  await iter.next()
  order.push('frame')
  report('C2 信号：onOpen 先于首帧交付', order.join(',') === 'open,frame', order.join(','))
  await iter.return?.()
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
