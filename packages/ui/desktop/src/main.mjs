import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = resolve(packageRoot, '../../..')
const sessionsRoot = resolve(repoRoot, '.sessions')
const feedbackRoot = resolve(sessionsRoot, '.desktop-feedback')
const acpConfigPath = resolve(repoRoot, 'examples/acp-agent/cordis.yml')

/** @type {BrowserWindow | undefined} */
let mainWindow

/** @type {'stopped' | 'starting' | 'running' | 'stopping' | 'error'} */
let runtimeState = 'stopped'
/** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */
let runtimeProcess
/** @type {ClientSideConnection | undefined} */
let acpClient
let initializeResult
let stderrTail = ''
/** @type {Map<string, {sessionId: string, loaded: boolean, cwd: string, title?: string}>} */
const activeSessions = new Map()

let interactionCounter = 0
/** @type {Map<string, {resolve: (response: unknown) => void, payload: unknown}>} */
const pendingInteractions = new Map()

/**
 * Ask the renderer to resolve a permission or elicitation card. The promise
 * settles when any window responds; pending cards replay on renderer reload.
 */
function requestRendererInteraction(kind, request) {
  return new Promise((resolve) => {
    const id = `interaction-${++interactionCounter}`
    const payload = { id, kind, ...request }
    pendingInteractions.set(id, { resolve, payload })
    broadcast('interaction:request', payload)
  })
}
const replayingSessions = new Set()

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

function setRuntimeState(next, extra = {}) {
  runtimeState = next
  broadcast('runtime:status-update', runtimeStatus(extra))
}

function runtimeStatus(extra = {}) {
  return {
    state: runtimeState,
    pid: runtimeProcess?.pid,
    repoRoot,
    sessionsRoot,
    configPath: acpConfigPath,
    initialized: initializeResult,
    stderrTail,
    ...extra,
  }
}

async function ensureRuntime() {
  if (acpClient !== undefined && runtimeState === 'running') return acpClient
  await startRuntime()
  if (acpClient === undefined) throw new Error('ACP runtime did not start')
  return acpClient
}

async function startRuntime() {
  if (runtimeState === 'running' || runtimeState === 'starting') return runtimeStatus()
  setRuntimeState('starting')
  stderrTail = ''
  activeSessions.clear()

  runtimeProcess = spawn('node', [
    '--import',
    'tsx',
    'packages/examples/acp-demo/src/bin.ts',
    '--config',
    relative(repoRoot, acpConfigPath),
  ], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  runtimeProcess.stderr.setEncoding('utf8')
  runtimeProcess.stderr.on('data', chunk => {
    stderrTail = `${stderrTail}${chunk}`.slice(-10_000)
    broadcast('runtime:stderr', { text: String(chunk), tail: stderrTail })
  })

  runtimeProcess.on('exit', (code, signal) => {
    runtimeProcess = undefined
    acpClient = undefined
    initializeResult = undefined
    activeSessions.clear()
    setRuntimeState(code === 0 ? 'stopped' : 'error', { exit: { code, signal } })
  })

  const stream = ndJsonStream(
    Writable.toWeb(runtimeProcess.stdin),
    Readable.toWeb(runtimeProcess.stdout),
  )

  acpClient = new ClientSideConnection(() => ({
    sessionUpdate(params) {
      if (replayingSessions.has(String(params.sessionId))) return Promise.resolve()
      const session = activeSessions.get(String(params.sessionId))
      if (session !== undefined && session.title === undefined && params.update?.sessionUpdate === 'user_message_chunk') {
        const title = textOfContent(params.update.content).trim()
        if (title.length > 0) session.title = title.slice(0, 120)
      }
      broadcast('sessions:update', params)
      return Promise.resolve()
    },
    async requestPermission(params) {
      const response = await requestRendererInteraction('permission', {
        sessionId: params.sessionId,
        title: params.toolCall?.title ?? 'Tool permission request',
        detail: params.toolCall?.rawInput ?? params.toolCall ?? {},
        options: params.options.map(option => ({ optionId: option.optionId, name: option.name ?? option.optionId, kind: option.kind })),
      })
      const optionId = response?.optionId
      if (typeof optionId === 'string' && params.options.some(option => option.optionId === optionId)) {
        return { outcome: { outcome: 'selected', optionId } }
      }
      return { outcome: { outcome: 'cancelled' } }
    },
    async unstable_createElicitation(params) {
      const response = await requestRendererInteraction('elicitation', {
        sessionId: params.sessionId,
        title: params.message,
        detail: params,
        options: [],
      })
      return response?.accepted === true ? { action: 'accept', content: {} } : { action: 'cancel' }
    },
  }), stream)

  initializeResult = await acpClient.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      _meta: { terminal_output: true },
    },
  })
  setRuntimeState('running')
  return runtimeStatus()
}

async function stopRuntime() {
  if (runtimeProcess === undefined) {
    setRuntimeState('stopped')
    return runtimeStatus()
  }
  setRuntimeState('stopping')
  const proc = runtimeProcess
  await new Promise(resolvePromise => {
    proc.once('exit', resolvePromise)
    proc.stdin.end()
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGTERM')
    }, 1000).unref()
  })
  return runtimeStatus()
}

function walkJsonl(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.desktop-feedback') walkJsonl(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full)
    }
  }
  return out
}

function readJsonl(file) {
  const text = readFileSync(file, 'utf8')
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
  const header = first?.type === 'session'
    ? { ...first, path: file }
    : { type: 'session', version: 0, id: file.split('/').at(-1)?.replace(/\.jsonl$/, ''), createdAt: 0, path: file }
  const events = first?.type === 'session' ? rows.slice(1) : rows
  return { header, events, rawText: text }
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (block?.type === 'text' || block?.type === 'reasoning') return block.text ?? ''
    if (block?.type === 'tool-call') return `[tool-call ${block.name}] ${block.arguments ?? ''}`
    return JSON.stringify(block)
  }).filter(Boolean).join('\n')
}

function latestHeader(events) {
  return events.filter(event => event.type === 'request/header' && event.data?.header).at(-1)?.data?.header ?? {}
}

function summarizeSession(file) {
  const { header, events } = readJsonl(file)
  const requestHeader = latestHeader(events)
  const firstUser = events.find(event => event.type === 'user/message')
  const last = events.at(-1)
  return {
    id: String(header.id),
    parentSession: header.parentSession === undefined ? undefined : String(header.parentSession),
    cwd: header.cwd,
    path: file,
    relativePath: relative(repoRoot, file),
    createdAt: header.createdAt || events[0]?.time || statSync(file).birthtimeMs,
    lastActivity: last?.time || statSync(file).mtimeMs,
    eventCount: events.length,
    turnCount: events.filter(event => event.type === 'turn/start').length,
    stepCount: events.filter(event => event.type === 'step/start').length,
    toolCallCount: events.filter(event => event.type === 'tool/call').length,
    model: requestHeader.config?.model,
    title: textOfContent(firstUser?.data?.content).slice(0, 120) || String(header.id),
    live: activeSessions.has(String(header.id)),
  }
}

function listSessions() {
  const persisted = walkJsonl(sessionsRoot).map(summarizeSession)
  const persistedIds = new Set(persisted.map(session => session.id))
  const liveOnly = [...activeSessions.values()]
    .filter(session => !persistedIds.has(session.sessionId))
    .map(session => ({
      id: session.sessionId,
      cwd: session.cwd,
      path: undefined,
      relativePath: undefined,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      eventCount: 0,
      turnCount: 0,
      stepCount: 0,
      toolCallCount: 0,
      model: undefined,
      title: session.title ?? 'New live session',
      live: true,
    }))
  return [...liveOnly, ...persisted].sort((a, b) => b.lastActivity - a.lastActivity)
}

function findSessionFile(sessionId) {
  return walkJsonl(sessionsRoot).find(file => {
    if (file.endsWith(`${sessionId}.jsonl`)) return true
    try {
      return String(readJsonl(file).header.id) === sessionId
    } catch {
      return false
    }
  })
}

function readTrace(sessionId) {
  const file = findSessionFile(sessionId)
  if (file === undefined) {
    return { found: false, sessionId, header: { id: sessionId, cwd: repoRoot }, events: [], rawText: '' }
  }
  const trace = readJsonl(file)
  const sessions = listSessions()
  const summary = sessions.find(session => session.id === sessionId)
  return {
    found: true,
    sessionId,
    header: trace.header,
    events: trace.events,
    rawText: trace.rawText,
    path: file,
    relativePath: relative(repoRoot, file),
    feedback: readFeedback(sessionId),
    parent: summary?.parentSession === undefined ? undefined : sessions.find(session => session.id === summary.parentSession) ?? { id: summary.parentSession },
    children: sessions.filter(session => session.parentSession === sessionId),
  }
}

function feedbackFile(sessionId) {
  return join(feedbackRoot, `${encodeURIComponent(sessionId)}.feedback.jsonl`)
}

function readFeedback(sessionId, targetId) {
  const file = feedbackFile(sessionId)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        return { type: 'feedback/parse-error', seq: index, time: 0, data: { line, error: String(error) } }
      }
    })
    .filter(record => targetId === undefined || record.data?.targetId === targetId)
}

function appendFeedback(entry) {
  const sessionId = String(entry.sessionId ?? '')
  if (sessionId.length === 0) throw new Error('sessionId is required')
  const rows = readFeedback(sessionId)
  const record = {
    type: 'feedback/add',
    seq: rows.length,
    time: Date.now(),
    data: {
      sessionId,
      targetId: String(entry.targetId ?? `session:${sessionId}`),
      targetTitle: String(entry.targetTitle ?? sessionId),
      targetKind: String(entry.targetKind ?? 'session'),
      author: String(entry.author ?? 'shentuni').trim() || 'shentuni',
      text: String(entry.text ?? '').trim(),
    },
  }
  if (record.data.text.length === 0) throw new Error('feedback text is required')
  mkdirSync(feedbackRoot, { recursive: true })
  appendFileSync(feedbackFile(sessionId), `${JSON.stringify(record)}\n`)
  return record
}

async function ensureSessionLoaded(sessionId) {
  if (activeSessions.has(sessionId)) return
  const summary = listSessions().find(session => session.id === sessionId)
  const client = await ensureRuntime()
  replayingSessions.add(sessionId)
  try {
    await client.loadSession({ sessionId, cwd: summary?.cwd ?? repoRoot, mcpServers: [] })
    activeSessions.set(sessionId, { sessionId, loaded: true, cwd: summary?.cwd ?? repoRoot })
  } finally {
    replayingSessions.delete(sessionId)
  }
}

function devStatus() {
  let dirty = false
  let branch = 'unknown'
  let commit = 'unknown'
  const configText = readTextSafe(acpConfigPath)
  const recentEvidence = summarizeRecentArtifactEvidence()
  try {
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0
    branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    // Keep the UI usable if git is unavailable.
  }
  return {
    runtime: runtimeStatus(),
    git: { dirty, branch, commit },
    watchedPaths: ['packages/**', 'examples/**', 'plugins/**', 'cordis.yml', 'package.json', 'pnpm-lock.yaml'],
    restartNeeded: dirty,
    recentPromptUses: recentEvidence.promptUses,
    recentToolCalls: recentEvidence.toolCalls,
    appComposition: {
      name: 'DeepSeek Harness ACP agent',
      entrypoint: 'packages/examples/acp-demo/src/bin.ts',
      configPath: relative(repoRoot, acpConfigPath),
      configText,
      plugins: parseCordisPlugins(configText),
      sourceFiles: [
        {
          label: 'ACP front door',
          path: 'packages/examples/acp-demo/src/index.ts',
          purpose: 'Loads the agent spine, JSONL persistence, user interaction service, and ACP bridge.',
          text: readTextSafe(join(repoRoot, 'packages/examples/acp-demo/src/index.ts')),
        },
        {
          label: 'Agent spine',
          path: 'packages/examples/agent-spine-demo/src/index.ts',
          purpose: 'Composes system prompt, tool registry, skills, agent registry, tasks, invariants, tool plugins, and agent loop.',
          text: readTextSafe(join(repoRoot, 'packages/examples/agent-spine-demo/src/index.ts')),
        },
        {
          label: 'System prompt service',
          path: 'packages/core/system-prompt/src/index.ts',
          purpose: 'Owns persona, tool order, and assembled model-facing prompt sections.',
          text: readTextSafe(join(repoRoot, 'packages/core/system-prompt/src/index.ts')),
        },
        {
          label: 'Tool registry',
          path: 'packages/core/tools/src/index.ts',
          purpose: 'Owns model-facing tool registration, schema validation, and tool presentation mode.',
          text: readTextSafe(join(repoRoot, 'packages/core/tools/src/index.ts')),
        },
      ],
    },
  }
}

function summarizeRecentArtifactEvidence() {
  const promptUses = []
  const toolCalls = new Map()
  for (const file of walkJsonl(sessionsRoot)) {
    let trace
    try {
      trace = readJsonl(file)
    } catch {
      continue
    }
    const sessionId = String(trace.header.id)
    for (const event of trace.events) {
      if (event.type === 'request/header' && event.data?.header) {
        const header = event.data.header
        promptUses.push({
          sessionId,
          relativePath: relative(repoRoot, file),
          seq: event.seq,
          time: event.time,
          systemChars: String(header.system ?? '').length,
          tools: Array.isArray(header.tools) ? header.tools.length : 0,
          model: header.config?.model,
        })
      }
      if (event.type === 'tool/call') {
        const name = String(event.data?.name ?? event.data?.toolName ?? 'tool')
        const existing = toolCalls.get(name) ?? {
          name,
          count: 0,
          lastSessionId: sessionId,
          lastRelativePath: relative(repoRoot, file),
          lastSeq: event.seq,
          lastTime: event.time,
        }
        existing.count += 1
        if ((event.time ?? 0) >= (existing.lastTime ?? 0)) {
          existing.lastSessionId = sessionId
          existing.lastRelativePath = relative(repoRoot, file)
          existing.lastSeq = event.seq
          existing.lastTime = event.time
        }
        toolCalls.set(name, existing)
      }
    }
  }
  return {
    promptUses: promptUses
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
      .slice(0, 8),
    toolCalls: [...toolCalls.values()]
      .sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0)),
  }
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    return `# Unable to read ${file}\n${String(error)}`
  }
}

function parseCordisPlugins(text) {
  const plugins = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^\s*-\s+id:\s*(.+?)\s*$/)
    if (id) {
      if (current !== undefined) plugins.push(current)
      current = { id: id[1], name: '', configPreview: '' }
      continue
    }
    if (current === undefined) continue
    const name = line.match(/^\s*name:\s*(.+?)\s*$/)
    if (name) {
      current.name = name[1].replace(/^['"]|['"]$/g, '')
      continue
    }
    if (/^\s{2,}\S/.test(line) && current.configPreview.length < 1600) {
      current.configPreview = `${current.configPreview}${line}\n`
    }
  }
  if (current !== undefined) plugins.push(current)
  return plugins
}

function registerIpc() {
  ipcMain.handle('runtime:start', async () => startRuntime())
  ipcMain.handle('runtime:stop', async () => stopRuntime())
  ipcMain.handle('runtime:restart', async () => {
    await stopRuntime()
    return startRuntime()
  })
  ipcMain.handle('runtime:status', () => runtimeStatus())
  ipcMain.handle('sessions:list', () => ({ root: sessionsRoot, sessions: listSessions() }))
  ipcMain.handle('sessions:create', async () => {
    const client = await ensureRuntime()
    const response = await client.newSession({ cwd: repoRoot, mcpServers: [] })
    activeSessions.set(response.sessionId, { sessionId: response.sessionId, loaded: true, cwd: repoRoot })
    return { ...response, trace: readTrace(response.sessionId) }
  })
  ipcMain.handle('sessions:load', async (_event, { sessionId }) => {
    await ensureSessionLoaded(String(sessionId))
    return { sessionId, trace: readTrace(String(sessionId)) }
  })
  ipcMain.handle('sessions:prompt', async (_event, { sessionId, text }) => {
    const id = String(sessionId)
    await ensureSessionLoaded(id)
    const client = await ensureRuntime()
    const response = await client.prompt({
      sessionId: id,
      prompt: [{ type: 'text', text: String(text) }],
    })
    return { response, trace: readTrace(id) }
  })
  ipcMain.handle('sessions:cancel', async (_event, { sessionId }) => {
    const client = await ensureRuntime()
    await client.cancel({ sessionId: String(sessionId) })
    return { ok: true }
  })
  ipcMain.handle('sessions:reveal', (_event, { sessionId }) => {
    const file = findSessionFile(String(sessionId))
    if (file === undefined) throw new Error(`session not found: ${String(sessionId)}`)
    shell.showItemInFolder(file)
    return { ok: true, path: file }
  })
  // Develop stays read-first: editing routes to the user's editor instead of an
  // in-app write path. Only repository paths may be opened.
  ipcMain.handle('dev:open-path', async (_event, { path }) => {
    const target = resolve(repoRoot, String(path))
    if (target !== repoRoot && !target.startsWith(`${repoRoot}/`)) {
      throw new Error(`path escapes the repository: ${String(path)}`)
    }
    if (!existsSync(target)) throw new Error(`path not found: ${String(path)}`)
    const error = await shell.openPath(target)
    if (error.length > 0) throw new Error(error)
    return { ok: true, path: target }
  })
  ipcMain.handle('trace:read', (_event, { sessionId }) => readTrace(String(sessionId)))
  ipcMain.handle('feedback:list', (_event, { sessionId, targetId }) => readFeedback(String(sessionId), targetId === undefined ? undefined : String(targetId)))
  ipcMain.handle('feedback:add', (_event, entry) => appendFeedback(entry))
  ipcMain.handle('dev:status', () => devStatus())
  ipcMain.handle('interaction:respond', (_event, { id, response }) => {
    const pending = pendingInteractions.get(String(id))
    if (pending === undefined) return { ok: false }
    pendingInteractions.delete(String(id))
    pending.resolve(response)
    return { ok: true }
  })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    title: 'DeepSeek Harness Desktop',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.on('did-finish-load', () => {
    for (const pending of pendingInteractions.values()) {
      mainWindow?.webContents.send('interaction:request', pending.payload)
    }
  })

  if (process.env.VITE_DEV_SERVER_URL !== undefined) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    if (process.env.DSH_DESKTOP_OPEN_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    const builtIndex = join(packageRoot, 'dist/index.html')
    if (!existsSync(builtIndex)) {
      await mainWindow.loadURL(`data:text/html,${encodeURIComponent('Run pnpm --dir packages/ui/desktop build:ui before pnpm --dir packages/ui/desktop start.')}`)
    } else {
      await mainWindow.loadURL(pathToFileURL(builtIndex).toString())
    }
  }
}

async function openWindowAndRuntime() {
  await createWindow()
  try {
    await startRuntime()
  } catch (error) {
    setRuntimeState('error', { error: String(error) })
  }
}

registerIpc()

app.whenReady().then(openWindowAndRuntime)

app.on('window-all-closed', () => {
  void stopRuntime().finally(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void openWindowAndRuntime()
})
