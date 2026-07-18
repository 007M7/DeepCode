#!/usr/bin/env node
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { URL } = require('node:url')

const PORT = Number(process.env.PORT || 5173)
const HOST = process.env.HOST || '127.0.0.1'
const DEFAULT_ROOT = path.join(process.cwd(), '.sessions')
const SESSIONS_ROOT = process.env.HARNESS_SESSIONS_ROOT || DEFAULT_ROOT
const STATIC_ROOT = __dirname
const FEEDBACK_ROOT = process.env.HARNESS_FEEDBACK_ROOT || path.join(STATIC_ROOT, '.feedback')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body, null, 2) : body
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendFile(res, full, type) {
  const body = fs.readFileSync(full)
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        req.destroy()
        reject(new Error('request body too large'))
      }
    })
    req.on('end', () => {
      if (!body.trim()) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function walkJsonl(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJsonl(full, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8')
  const rows = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      rows.push({ type: 'parse/error', seq: index, time: 0, data: { line, error: String(error) } })
    }
  }
  const first = rows[0]
  const meta = first?.type === 'session'
    ? { ...first, path: file }
    : { type: 'session', version: 0, id: path.basename(file, '.jsonl'), createdAt: 0, path: file }
  const events = first?.type === 'session' ? rows.slice(1) : rows
  return { meta, events, rawText: text }
}

function feedbackFile(sessionId) {
  return path.join(FEEDBACK_ROOT, `${encodeURIComponent(sessionId)}.feedback.jsonl`)
}

function readFeedback(sessionId) {
  const file = feedbackFile(sessionId)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        return { type: 'feedback/parse-error', seq: index, time: 0, data: { line, error: String(error) } }
      }
    })
}

function appendFeedback(sessionId, data) {
  fs.mkdirSync(FEEDBACK_ROOT, { recursive: true })
  const rows = readFeedback(sessionId)
  const record = {
    type: 'feedback/add',
    seq: rows.length,
    time: Date.now(),
    data: {
      sessionId,
      targetId: String(data.targetId || `session:${sessionId}`),
      targetTitle: String(data.targetTitle || sessionId),
      targetKind: String(data.targetKind || 'session'),
      author: String(data.author || 'anonymous').trim() || 'anonymous',
      text: String(data.text || '').trim(),
    },
  }
  if (!record.data.text) throw new Error('feedback text is required')
  fs.appendFileSync(feedbackFile(sessionId), `${JSON.stringify(record)}\n`)
  return record
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text || ''
    if (block.type === 'tool-call') return `[tool-call ${block.name}] ${block.arguments || ''}`
    if (block.type === 'tool-result') return `[tool-result] ${JSON.stringify(block.content ?? block)}`
    return JSON.stringify(block)
  }).filter(Boolean).join('\n')
}

function latestHeader(events) {
  const headers = events.filter(event => event.type === 'request/header' && event.data?.header)
  return headers.at(-1)?.data?.header ?? {}
}

function summarize(file) {
  const { meta, events } = readJsonl(file)
  const header = latestHeader(events)
  const last = events.at(-1)
  const firstUser = events.find(event => event.type === 'user/message')
  return {
    id: String(meta.id),
    parentSession: meta.parentSession ? String(meta.parentSession) : undefined,
    cwd: meta.cwd,
    path: file,
    createdAt: meta.createdAt || events[0]?.time || 0,
    lastActivity: last?.time || meta.createdAt || 0,
    eventCount: events.length,
    turnCount: events.filter(event => event.type === 'turn/start').length,
    stepCount: events.filter(event => event.type === 'step/start').length,
    toolCallCount: events.filter(event => event.type === 'tool/call').length,
    model: header.config?.model,
    title: textOfContent(firstUser?.data?.content).slice(0, 120) || String(meta.id),
  }
}

// Reveal a file in the OS file manager. The path always comes from
// findSessionFile (never from the request), and execFile takes an argv array —
// no shell, no injection surface.
function revealInFileManager(file) {
  if (process.platform === 'darwin') execFile('open', ['-R', file], () => {})
  else if (process.platform === 'win32') execFile('explorer', [`/select,${file}`], () => {})
  else execFile('xdg-open', [path.dirname(file)], () => {})
}

function findSessionFile(id) {
  const files = walkJsonl(SESSIONS_ROOT)
  const byName = files.find(file => path.basename(file, '.jsonl') === id)
  if (byName) return byName
  return files
    .map(file => ({ file, summary: summarize(file) }))
    .find(item => item.summary.id === id)?.file
}

function parseArguments(text) {
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function makeNode({ id, kind, title, subtitle, startTime, status = 'ok' }) {
  return {
    id, kind, title, subtitle, status,
    startTime, endTime: startTime, startSec: 0, durationSec: 0,
    children: [], rawEvents: [], detail: {},
  }
}

function assignTiming(node, zero, fallbackEnd) {
  const start = Number.isFinite(node.startTime) ? node.startTime : zero
  const end = Math.max(start, Number.isFinite(node.endTime) ? node.endTime : fallbackEnd)
  node.startSec = Math.max(0, (start - zero) / 1000)
  node.durationSec = Math.max(0, (end - start) / 1000)
  for (const child of node.children) assignTiming(child, zero, fallbackEnd)
}

function buildSession(file) {
  const { meta, events } = readJsonl(file)
  const firstTime = events[0]?.time || meta.createdAt || Date.now()
  const lastTime = events.at(-1)?.time || firstTime
  const headerEvents = events.filter(event => event.type === 'request/header' && event.data?.header)
  const header = latestHeader(events)
  const tools = Array.isArray(header.tools) ? header.tools : []
  const toolsByName = new Map(tools.map(tool => [tool.name, tool]))

  const root = makeNode({
    id: `session:${meta.id}`,
    kind: 'session',
    title: String(meta.id),
    subtitle: meta.cwd || path.dirname(file),
    startTime: firstTime,
  })
  root.endTime = lastTime
  root.rawEvents = events

  const turnMap = new Map()
  const stepMap = new Map()
  const toolMap = new Map()
  const firstChunkByStep = new Map()

  for (const event of events) {
    if (event.type === 'assistant/chunk') {
      const key = `${event.data?.turn}:${event.data?.step}`
      if (!firstChunkByStep.has(key)) firstChunkByStep.set(key, event.time)
    }
  }

  let currentTurn
  let currentStep
  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = event.data.turn
      const node = makeNode({
        id: `turn:${turn}`,
        kind: 'turn',
        title: `turn ${turn}`,
        subtitle: event.data.trigger?.kind || 'turn/start',
        startTime: event.time,
      })
      node.rawEvents.push(event)
      root.children.push(node)
      turnMap.set(turn, node)
      currentTurn = node
      currentStep = undefined
    } else if (event.type === 'turn/end') {
      const node = turnMap.get(event.data.turn)
      if (node) {
        node.endTime = event.time
        node.status = event.data.reason?.kind === 'completed' ? 'ok' : 'error'
        node.rawEvents.push(event)
      }
    } else if (event.type === 'step/start') {
      const turn = turnMap.get(event.data.turn) || currentTurn || root
      const key = `${event.data.turn}:${event.data.step}`
      const node = makeNode({
        id: `step:${key}`,
        kind: 'step',
        title: `step ${event.data.step}`,
        subtitle: `turn ${event.data.turn}`,
        startTime: event.time,
      })
      node.rawEvents.push(event)
      turn.children.push(node)
      stepMap.set(key, node)
      currentStep = node
    } else if (event.type === 'step/end') {
      const node = stepMap.get(`${event.data.turn}:${event.data.step}`)
      if (node) {
        node.endTime = event.time
        node.rawEvents.push(event)
      }
    } else if (event.type === 'request/header') {
      const node = currentStep || currentTurn || root
      node.rawEvents.push(event)
      node.detail.promptSeq = event.seq
    } else if (event.type === 'assistant/message') {
      const key = `${event.data.turn}:${event.data.step}`
      const step = stepMap.get(key) || currentStep || root
      const startTime = firstChunkByStep.get(key) ?? event.time
      const text = textOfContent(event.data.content)
      const node = makeNode({
        id: `assistant:${event.seq}`,
        kind: 'llm',
        title: 'assistant/message',
        subtitle: text.slice(0, 96) || 'assembled assistant message',
        startTime,
      })
      node.endTime = event.time
      node.rawEvents.push(event)
      node.detail = {
        input: event.data.usage ? { usage: event.data.usage } : '',
        output: event.data.content,
        promptSeq: step.detail.promptSeq,
      }
      step.children.push(node)
      step.rawEvents.push(event)
    } else if (event.type === 'tool/call') {
      const key = `${event.data.turn}:${event.data.step}`
      const step = stepMap.get(key) || currentStep || root
      const node = makeNode({
        id: `tool:${event.data.callId}`,
        kind: 'tool',
        title: event.data.name,
        subtitle: event.data.callId,
        startTime: event.time,
      })
      node.rawEvents.push(event)
      node.detail = {
        input: parseArguments(event.data.arguments),
        output: '',
        promptSeq: step.detail.promptSeq,
        schema: toolsByName.get(event.data.name),
      }
      step.children.push(node)
      step.rawEvents.push(event)
      toolMap.set(event.data.callId, node)
    } else if (event.type === 'tool/result') {
      const node = toolMap.get(event.data.callId)
      if (node) {
        node.endTime = event.time
        node.status = event.data.isError ? 'error' : 'ok'
        node.rawEvents.push(event)
        node.detail.output = {
          content: event.data.content,
          isError: event.data.isError,
          error: event.data.error,
          meta: event.data.meta,
        }
      }
    } else {
      const target = currentStep || currentTurn || root
      target.rawEvents.push(event)
    }
  }

  assignTiming(root, firstTime, lastTime)

  const messages = events
    .filter(event => ['user/message', 'assistant/message', 'tool/result', 'context/message', 'steering/message'].includes(event.type))
    .map(event => ({
      seq: event.seq,
      time: event.time,
      type: event.type,
      role: event.type === 'assistant/message' ? 'assistant' : event.type === 'tool/result' ? 'tool' : 'user',
      content: event.data.content,
      text: textOfContent(event.data.content),
    }))

  const stats = {
    startTime: firstTime,
    durationSec: Math.max(0, (lastTime - firstTime) / 1000),
    turns: events.filter(event => event.type === 'turn/start').length,
    steps: events.filter(event => event.type === 'step/start').length,
    toolCalls: events.filter(event => event.type === 'tool/call').length,
    llmMessages: events.filter(event => event.type === 'assistant/message').length,
  }

  // Serialize the tree with event seq references instead of embedded event
  // copies: every event is already shipped once in `events`, so nodes carry
  // `eventSeqs` and the client resolves them through its seq index.
  const packNode = (node) => {
    const { rawEvents, children, ...rest } = node
    return { ...rest, eventSeqs: rawEvents.map(event => event.seq), children: children.map(packNode) }
  }

  const siblings = listSessions()
  const sessionId = String(meta.id)
  const children = siblings.filter(summary => summary.parentSession === sessionId)
  const parent = meta.parentSession
    ? siblings.find(summary => summary.id === String(meta.parentSession)) ?? { id: String(meta.parentSession) }
    : undefined

  return {
    header: { ...meta, path: file },
    stats,
    agent: {
      id: 'A_main',
      model: header.config?.model,
      systemPrompt: header.system || '',
      messagePrefix: header.messagePrefix,
      tools,
      headerEvents: headerEvents.length,
      latestHeader: header,
    },
    tree: packNode(root),
    messages,
    events,
    children,
    parent,
    feedback: readFeedback(sessionId),
  }
}

function listSessions() {
  return walkJsonl(SESSIONS_ROOT)
    .filter(file => !path.basename(file).startsWith('stdout.'))
    .map(summarize)
    .sort((a, b) => b.lastActivity - a.lastActivity)
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname
  const decoded = decodeURIComponent(target)
  const full = path.normalize(path.join(STATIC_ROOT, decoded))
  if (full !== STATIC_ROOT && !full.startsWith(STATIC_ROOT + path.sep)) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8')
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain; charset=utf-8')
  const ext = path.extname(full)
  sendFile(res, full, MIME[ext] || 'application/octet-stream')
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, root: SESSIONS_ROOT })
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      return send(res, 501, {
        error: 'New live sessions are not connected yet. This prototype currently replays persisted JSONL sessions.',
        next: 'Wire this endpoint to the Harness ACP/stdio runtime to create a live session.',
      })
    }
    if (url.pathname === '/api/sessions') return send(res, 200, { root: SESSIONS_ROOT, sessions: listSessions() })
    if (url.pathname.startsWith('/api/sessions/')) {
      const suffix = decodeURIComponent(url.pathname.slice('/api/sessions/'.length))
      if (suffix.endsWith('/feedback')) {
        const id = suffix.slice(0, -'/feedback'.length)
        if (req.method === 'GET') return send(res, 200, { feedback: readFeedback(id) })
        if (req.method === 'POST') return send(res, 200, { feedback: appendFeedback(id, await readJsonBody(req)) })
      }
      if (req.method === 'POST' && suffix.endsWith('/reveal')) {
        const id = suffix.slice(0, -'/reveal'.length)
        const file = findSessionFile(id)
        if (!file) return send(res, 404, { error: `session not found: ${id}` })
        revealInFileManager(file)
        return send(res, 200, { ok: true, path: file })
      }
      if (req.method === 'POST' && suffix.endsWith('/messages')) {
        return send(res, 501, {
          error: 'Live interaction is not connected yet. This prototype is reading persisted JSONL replay data.',
          next: 'Wire this endpoint to the Harness ACP/stdio runtime to continue a session.',
        })
      }
      const id = suffix
      const file = findSessionFile(id)
      if (!file) return send(res, 404, { error: `session not found: ${id}` })
      return send(res, 200, buildSession(file))
    }
    serveStatic(req, res, url.pathname)
  } catch (error) {
    send(res, 500, { error: String(error?.stack || error) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Harness Local Workbench listening on http://${HOST}:${PORT}`)
  console.log(`Reading sessions from ${SESSIONS_ROOT}`)
})
