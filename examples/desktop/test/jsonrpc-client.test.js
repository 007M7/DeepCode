// Unit tests for the JSON-RPC client. Runs under `node --test`, no Electron.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { JsonRpcClient, JsonRpcError } = require('../src/main/jsonrpc-client.js')

function makeClient(overrides = {}) {
  const writes = []
  const client = new JsonRpcClient({
    write: (frame) => writes.push(frame),
    onNotify: (m, p) => { /* set by test */ },
    onProtocolError: () => {},
    ...overrides,
  })
  return { client, writes }
}

test('request writes a framed JSON-RPC 2.0 payload with an incrementing id', () => {
  const { client, writes } = makeClient()
  const p1 = client.request('initialize', { cwd: '/tmp', model: 'x' })
  const p2 = client.request('shutdown')
  assert.equal(writes.length, 2)
  const f1 = JSON.parse(writes[0])
  assert.deepEqual(f1, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: '/tmp', model: 'x' } })
  const f2 = JSON.parse(writes[1])
  assert.equal(f2.id, 2)
  assert.equal(writes[0].endsWith('\n'), true)
  // Resolve them so the promises don't dangle.
  client.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n')
  client.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }) + '\n')
  return Promise.all([p1, p2])
})

test('feed splits on newline and buffers partial lines', async () => {
  const { client, writes } = makeClient()
  const p = client.request('foo')
  // Server splits its response across three chunks.
  const resp = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n'
  client.feed(resp.slice(0, 10))
  client.feed(resp.slice(10, 25))
  client.feed(resp.slice(25))
  const r = await p
  assert.deepEqual(r, { ok: true })
})

test('error responses reject with a JsonRpcError carrying code/data', async () => {
  const { client } = makeClient()
  const p = client.request('bad')
  client.feed(JSON.stringify({
    jsonrpc: '2.0', id: 1,
    error: { code: -32601, message: 'method not found', data: { hint: 'x' } },
  }) + '\n')
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof JsonRpcError)
    assert.equal(err.code, -32601)
    assert.equal(err.message, 'method not found')
    assert.deepEqual(err.data, { hint: 'x' })
    return true
  })
})

test('notifications route to onNotify and are never awaited', () => {
  const seen = []
  const { client } = makeClient({ onNotify: (m, p) => seen.push([m, p]) })
  client.feed(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 's', event: { type: 'turn/end', data: {} } } }) + '\n')
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'session.event')
  assert.equal(seen[0][1].sessionId, 's')
})

test('inbound requests dispatch to registered handlers and reply with result', async () => {
  const writes = []
  const client = new JsonRpcClient({
    write: (frame) => writes.push(frame),
    onServerRequest: { 'ping': async (params) => ({ pong: params.n + 1 }) },
    onProtocolError: () => {},
  })
  client.feed(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping', params: { n: 1 } }) + '\n')
  // Give the microtask queue a tick.
  await new Promise((r) => setImmediate(r))
  const reply = JSON.parse(writes[0])
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 42, result: { pong: 2 } })
})

test('inbound request for unknown method replies with -32601', async () => {
  const writes = []
  const client = new JsonRpcClient({ write: (f) => writes.push(f), onProtocolError: () => {} })
  client.feed(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'nope' }) + '\n')
  await new Promise((r) => setImmediate(r))
  const reply = JSON.parse(writes[0])
  assert.equal(reply.error.code, -32601)
  assert.equal(reply.id, 7)
})

test('reset rejects all in-flight requests', async () => {
  const { client } = makeClient()
  const p1 = client.request('a')
  const p2 = client.request('b')
  client.reset('gone')
  await assert.rejects(p1, /gone/)
  await assert.rejects(p2, /gone/)
})

test('bad JSON on the wire routes to onProtocolError without dropping later frames', async () => {
  const errs = []
  const seen = []
  const { client } = makeClient({
    onProtocolError: (e) => errs.push(e),
    onNotify: (m, p) => seen.push([m, p]),
  })
  client.feed('this is not json\n')
  client.feed(JSON.stringify({ jsonrpc: '2.0', method: 'ok', params: {} }) + '\n')
  assert.equal(errs.length, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'ok')
})

test('response for an unknown id reports a protocol error rather than throwing', () => {
  const errs = []
  const { client } = makeClient({ onProtocolError: (e) => errs.push(e) })
  client.feed(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }) + '\n')
  assert.equal(errs.length, 1)
  assert.match(errs[0].message, /unknown id/)
})
