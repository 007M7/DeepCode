/**
 * Local interactive DeepSeek CLI: one direct Agent driver over the shared
 * runtime services, with an Ink terminal surface and a plain non-TTY fallback.
 * @module @deepseek-ai/dsh-cli-app
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { createUserMessage, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { CHAT_PROMPT_LABEL } from './brand.ts'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-commands'
import { createCliSurface, isSurfaceClosed } from './surface.ts'
import type { CliIdentity, CliSurface, CliUsageStatus } from './surface.ts'

/** Stable Cordis plugin name. */
export const name = 'cli-runner'

/** Runtime services needed for the complete local CLI. */
export const inject = [
  'agentDefaultModel', 'agents', 'sessions', 'sessionPersistence', 'cliStartup',
  'approval', 'userQuestions', 'credentials', 'llm', 'commands',
  'settings', 'sessionProjections',
]

/** Plugin configuration. */
export interface Config {
  /** Absolute working directory for fresh sessions and resume filtering. */
  cwd: string
  /** Product version shown in the welcome card. */
  version?: string
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  cwd: z.string().required(),
  version: z.string().default('0.1.0-rc.5'),
})

interface CliIo {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  exit(code: number): void
}

/** Process streams and terminal-mode override used by focused tests. */
export const internals: {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  terminal: boolean | undefined
} = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  terminal: undefined,
}

interface LiveSession {
  handle: AgentHandle
  selection: ModelSelectionRef
  streamedSteps: Set<string>
  toolNames: Map<string, string>
  toolCounts: Map<string, number>
  toolDetails: string[]
}

const BUILTIN_COMMANDS = [
  'help', 'login', 'logout', 'status', 'model', 'models', 'new', 'sessions',
  'resume', 'clear', 'exit',
] as const

const TOOL_LABELS: Readonly<Record<string, string>> = {
  read: 'Read files',
  grep: 'Search text',
  glob: 'Find files',
  edit: 'Edit files',
  write: 'Write files',
  pwsh: 'Run PowerShell',
  bash: 'Run shell',
  todo_write: 'Update tasks',
}

/** Human-facing label for a model tool name. */
function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replaceAll('_', ' ')
}

/** Bound raw arguments kept for the optional Ctrl+O detail panel. */
function compactToolArguments(argumentsJson: string): string {
  const limit = 240
  return argumentsJson.length <= limit ? argumentsJson : `${argumentsJson.slice(0, limit - 1)}…`
}

/** Collapse one turn's successful and failed calls into a readable activity summary. */
function flushToolSummary(surface: CliSurface, live: LiveSession): void {
  const count = [...live.toolCounts.values()].reduce((total, value) => total + value, 0)
  if (count === 0) return
  const groups = [...live.toolCounts]
    .map(([name, calls]) => `${toolLabel(name)} ×${calls}`)
    .join(' · ')
  const omitted = count - live.toolDetails.length
  const details = [...live.toolDetails, ...omitted > 0 ? [`… ${omitted} more calls`] : []].join('\n')
  surface.addTool(`${count} tool call${count === 1 ? '' : 's'} · ${groups}`, details)
  live.toolCounts.clear()
  live.toolDetails.length = 0
}

/** Option lookup by 1-based index. */
function optionByNumber(options: readonly AskUserQuestionOption[], token: string): AskUserQuestionOption | undefined {
  const index = Number(token)
  if (!Number.isInteger(index) || index < 1 || index > options.length) return undefined
  return options[index - 1]
}

/** Option lookup by index or exact label. */
function optionByToken(options: readonly AskUserQuestionOption[], token: string): AskUserQuestionOption | undefined {
  return optionByNumber(options, token) ?? options.find(option => option.label === token)
}

/** Resolve a numbered or exact-label picker answer without parsing its display text. */
function pickerId(
  entries: readonly { readonly id: string }[],
  labels: readonly string[],
  answer: string,
): string {
  const value = answer.trim()
  const index = Number(value)
  const labelIndex = labels.indexOf(value)
  if (labelIndex >= 0) return entries[labelIndex]?.id ?? value
  return Number.isInteger(index) && index >= 1 && index <= entries.length
    ? entries[index - 1]?.id ?? value
    : value
}

/** Convert one typed answer into the existing question protocol. */
function parseQuestionAnswer(question: AskUserQuestionItem, raw: string): AskUserQuestionAnswerItem {
  const line = raw.trim()
  const options = question.options ?? []
  if (options.length === 0) {
    return { id: question.id, selected: [], ...line === '' ? {} : { custom: line } }
  }
  if (question.multiSelect === true) {
    const selected: string[] = []
    const custom: string[] = []
    for (const token of line.split(',').map(part => part.trim()).filter(Boolean)) {
      const option = optionByToken(options, token)
      if (option === undefined) custom.push(token)
      else selected.push(option.label)
    }
    return { id: question.id, selected, ...custom.length === 0 ? {} : { custom: custom.join(', ') } }
  }
  const option = optionByToken(options, line)
  if (option !== undefined) return { id: question.id, selected: [option.label] }
  return { id: question.id, selected: [], ...line === '' ? {} : { custom: line } }
}

/** Ask one model-owned question through the shared surface. */
async function answerQuestion(
  surface: CliSurface,
  question: AskUserQuestionItem,
  signal?: AbortSignal,
): Promise<AskUserQuestionAnswerItem> {
  const options = (question.options ?? []).map(option => option.label)
  const descriptions = (question.options ?? [])
    .flatMap(option => option.description === undefined ? [] : [`${option.label}: ${option.description}`])
  const detail = [question.header === undefined ? undefined : question.question, question.detail, ...descriptions]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n')
  let raw: string
  try {
    raw = await surface.ask({
      kind: 'question',
      label: question.header ?? question.question,
      ...detail === '' ? {} : { detail },
      ...options.length === 0 ? {} : { options },
      ...question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect },
    }, signal)
  } catch (error) {
    if (signal?.aborted === true || isSurfaceClosed(error, surface)) {
      throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    throw error
  }
  return parseQuestionAnswer(question, raw)
}

/** Answer one whole question request in order. */
async function answerQuestions(surface: CliSurface, request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  for (const question of request.questions) {
    answers.push(await answerQuestion(surface, question, request.signal))
  }
  return { answers }
}

/** Present a fail-closed approval picker. */
async function answerApproval(surface: CliSurface, request: ApprovalRequest): Promise<ApprovalOutcome> {
  try {
    const answer = await surface.ask({
      kind: 'approval',
      label: `Allow ${request.toolName}?`,
      ...request.reason === undefined ? {} : { detail: request.reason },
      options: ['Reject', 'Allow once'],
    }, request.signal)
    const normalized = answer.trim().toLowerCase()
    return normalized === '2' || normalized === 'allow once' || normalized === 'y' || normalized === 'yes'
      ? 'allowed-once'
      : 'rejected'
  } catch (error) {
    if (request.signal?.aborted === true || isSurfaceClosed(error, surface)) return 'cancelled'
    throw error
  }
}

/** Render durable events without inventing model-visible state. */
function renderSessionEvent(surface: CliSurface, live: LiveSession, event: SessionEvent): void {
  surface.markActivity()
  if (event.type === 'assistant/chunk') {
    if (event.data.chunk.type !== 'text-delta') return
    surface.appendAssistant(event.data.chunk.text)
    live.streamedSteps.add(`${event.data.turn}:${event.data.step}`)
    return
  }
  if (event.type === 'assistant/message') {
    if (live.streamedSteps.has(`${event.data.turn}:${event.data.step}`)) return
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text !== '') surface.fallbackAssistant(text)
    return
  }
  if (event.type === 'tool/call') {
    live.toolNames.set(event.data.callId, event.data.name)
    live.toolCounts.set(event.data.name, (live.toolCounts.get(event.data.name) ?? 0) + 1)
    if (live.toolDetails.length < 20) {
      live.toolDetails.push(`${toolLabel(event.data.name)}: ${compactToolArguments(event.data.arguments)}`)
    }
    return
  }
  if (event.type === 'tool/result') {
    const callId = event.data.message.source.callId
    const name = live.toolNames.get(callId) ?? callId
    live.toolNames.delete(callId)
    if (event.data.error !== undefined) {
      surface.addTool(`failed ${name}`, `${event.data.error.code}: ${event.data.error.name}`, true)
    }
    return
  }
  if (event.type === 'turn/end') {
    flushToolSummary(surface, live)
    surface.endAssistant(event.data.reason)
  }
}

/** Read one path from a resolved settings section. */
function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Resolve the selected provider's configured credential reference. */
function selectedCredentialRef(ctx: Context, live: LiveSession): ReturnType<typeof credentialRef> | undefined {
  const selection = live.selection.current
  if (selection === undefined) return undefined
  const provider = ctx.llm.listConfigurableProviders().find(entry => entry.provider === selection.provider)
  if (provider === undefined) return undefined
  const namespace = ctx.settings.describe({ redactSecrets: true })
    .find(entry => String(entry.ns) === provider.settingsNs)
  const profile = valueAtPath(namespace?.value, provider.settingsPath)
  if (typeof profile !== 'object' || profile === null) return undefined
  const value = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof value === 'string' && value !== '' ? credentialRef(value) : undefined
}

/** Describe auth state without resolving or exposing the credential value. */
async function authIdentity(
  ctx: Context,
  live: LiveSession,
): Promise<Pick<CliIdentity, 'authenticated' | 'credentialSource'>> {
  const ref = selectedCredentialRef(ctx, live)
  if (ref === undefined) return { authenticated: false }
  const info = await ctx.credentials.describe(ref)
  return {
    authenticated: info.configured,
    ...info.source === undefined ? {} : { credentialSource: info.source },
  }
}

/** Build a display identity from authoritative live facts. */
async function identityFor(
  ctx: Context,
  config: Config,
  live: LiveSession,
): Promise<CliIdentity> {
  const selected = live.selection.current
  if (selected === undefined) throw new Error('CLI session has no selected model')
  return {
    version: config.version ?? '0.1.0-rc.5',
    cwd: live.handle.agent.session.header.cwd ?? config.cwd,
    sessionId: String(live.handle.agent.id),
    provider: selected.provider,
    model: selected.model,
    ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(selected.reasoningEffort) },
    ...await authIdentity(ctx, live),
  }
}

/** Install a mutable selection reference when creating or resuming an Agent. */
function selectionSetup(selection: ModelSelectionRef): (agentCtx: Context) => void {
  return (agentCtx) => { installModelSelection(agentCtx, selection) }
}

/** Create a fresh live session. */
async function createFresh(ctx: Context, cwd: string): Promise<LiveSession> {
  const current = ctx.agentDefaultModel.currentSelection()
  const selection: ModelSelectionRef = { current, assembled: undefined }
  const handle = await ctx.agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd },
    agentOptions: { provider: current.provider, model: current.model },
    setup: selectionSetup(selection),
  })
  return { handle, selection, streamedSteps: new Set(), toolNames: new Map(), toolCounts: new Map(), toolDetails: [] }
}

/** Restore the latest logged selection or the live default for a resumed Agent. */
async function resumeSession(ctx: Context, sessionId: string, cwd: string): Promise<LiveSession> {
  const header = (await ctx.sessionPersistence.list()).find(entry => String(entry.id) === sessionId)
  if (header === undefined) throw new Error(`Session "${sessionId}" does not exist.`)
  if (header.origin === 'subagent') throw new Error('Subagent sessions cannot be resumed as the root CLI agent.')
  if (header.cwd === undefined) throw new Error('That session has no recorded workspace and cannot be resumed safely.')
  if (header.cwd !== cwd) throw new Error(`That session belongs to ${header.cwd}; launch deepseek from that directory to resume it.`)
  const inspected = await ctx.sessionPersistence.load(SessionId(sessionId))
  if (resolveSessionPreset({ header: inspected.meta, events: inspected.events }) !== undefined) {
    throw new Error('That session uses an Agent preset which the local CLI profile does not compose.')
  }
  const logged = [...inspected.events].reverse().find(event => event.type === 'request/header')
  const current: ModelSelection = logged?.type === 'request/header'
    ? {
      provider: logged.data.header.config.provider,
      model: logged.data.header.config.model,
      ...logged.data.header.config.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: logged.data.header.config.reasoningEffort },
    }
    : ctx.agentDefaultModel.currentSelection()
  const selection: ModelSelectionRef = { current, assembled: undefined }
  const handle = await ctx.agents.resume({
    resumeSessionId: SessionId(sessionId),
    agentOptions: { provider: current.provider, model: current.model },
    setup: selectionSetup(selection),
  })
  return { handle, selection, streamedSteps: new Set(), toolNames: new Map(), toolCounts: new Map(), toolDetails: [] }
}

/** Compact one session header for `/sessions`. */
function sessionLine(header: SessionHeader, currentId: string): string {
  const marker = String(header.id) === currentId ? '*' : ' '
  const time = new Date(header.createdAt).toLocaleString()
  const cwd = header.cwd ?? '<no cwd>'
  return `${marker} ${String(header.id)}  ${time}  ${cwd}`
}

/** Resolve `/model` arguments or interactive catalog selection. */
async function chooseModel(
  ctx: Context,
  surface: CliSurface,
  rawInput: string,
): Promise<ModelSelection | undefined> {
  const providers = ctx.llm.listProviders()
  if (providers.length === 0) {
    surface.addNotice('No model providers are registered.', 'error')
    return undefined
  }
  const tokens = rawInput.trim().split(/\s+/u).filter(Boolean)
  let provider = tokens[0]
  let model = tokens[1]
  let effort = tokens[2]
  if (provider === undefined) {
    const options = providers.map(entry => `${entry.id} — ${entry.name}`)
    const answer = await surface.ask({ kind: 'question', label: 'Select a provider', options })
    provider = pickerId(providers, options, answer)
  }
  if (provider === '') {
    surface.addNotice('Provider id cannot be empty.', 'error')
    return undefined
  }
  const models = await ctx.llm.listModels(provider)
  if (model === undefined) {
    if (models.length === 0) {
      model = await surface.ask({ kind: 'question', label: `Model id for ${provider}` })
    } else {
      const options = models.map(entry => `${entry.id} — ${entry.name}`)
      const answer = await surface.ask({ kind: 'question', label: `Select a ${provider} model`, options })
      model = pickerId(models, options, answer)
    }
  }
  if (model === '') {
    surface.addNotice('Model id cannot be empty.', 'error')
    return undefined
  }
  const info = await ctx.llm.resolveModelInfo(provider, model)
  const efforts = info.reasoning?.efforts ?? []
  if (effort === undefined && efforts.length > 0) {
    const options = ['Provider default', ...efforts.map(entry => `${String(entry.id)} — ${entry.name}`)]
    const answer = await surface.ask({ kind: 'question', label: 'Reasoning effort', options })
    const value = answer.trim()
    const numericIndex = Number(value)
    const selectedIndex = Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= options.length
      ? numericIndex - 1
      : options.indexOf(value)
    if (selectedIndex === 0) effort = undefined
    else if (selectedIndex >= 1) {
      effort = String(efforts[selectedIndex - 1]?.id ?? '')
    } else effort = answer.trim()
  }
  const resolved = await ctx.llm.resolveCallConfig({
    provider,
    model,
    ...effort === undefined || effort === '' ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  })
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
  }
}

/** Execute one built-in command; returns replacement session or loop control. */
async function executeBuiltin(
  ctx: Context,
  config: Config,
  surface: CliSurface,
  live: LiveSession,
  line: string,
): Promise<{ live?: LiveSession; exit?: true; handled: boolean }> {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/u.exec(line.trim())
  if (match === null) return { handled: false }
  const command = match[1] ?? ''
  const rawInput = match[2] ?? ''
  if (!BUILTIN_COMMANDS.includes(command as typeof BUILTIN_COMMANDS[number])) return { handled: false }
  if (command === 'exit') return { handled: true, exit: true }
  if (command === 'clear') { surface.clear(); return { handled: true } }
  if (command === 'help') {
    const pluginCommands = ctx.commands.list(live.handle.agent)
    surface.addNotice([
      'DeepCode commands:',
      '  /login       store a DeepSeek API key securely',
      '  /logout      remove the managed DeepSeek API key',
      '  /model       select provider, model, and reasoning effort',
      '  /models      list registered provider catalogs',
      '  /new         start a fresh session',
      '  /sessions    list persisted sessions',
      '  /resume ID   resume a persisted session',
      '  /status      show auth, model, session, and workspace',
      '  /clear       clear terminal scrollback',
      '  /help        show built-in and registered plugin commands',
      '  /exit        flush and exit',
      ...pluginCommands.length === 0 ? [] : [
        '',
        'Plugin commands:',
        ...pluginCommands.map(entry => `  /${entry.name}${entry.input === undefined ? '' : ` ${entry.input.hint}`}  ${entry.description}`),
      ],
    ].join('\n'), 'command')
    return { handled: true }
  }
  if (command === 'login') {
    if (rawInput !== '') {
      surface.addNotice('/login never accepts a key on the command line; run /login and paste it into the masked prompt.', 'error')
      return { handled: true }
    }
    const ref = selectedCredentialRef(ctx, live)
    if (ref === undefined) {
      surface.addNotice('The selected provider does not expose a writable API-key credential.', 'error')
      return { handled: true }
    }
    const info = await ctx.credentials.describe(ref)
    if (!info.writable) {
      surface.addNotice(`${String(ref)} is supplied read-only by ${info.source ?? 'the environment'}; restart without that value to change it.`, 'error')
      return { handled: true }
    }
    const raw = await surface.ask({ kind: 'secret', label: 'Paste DeepSeek API key', detail: 'Input is masked and never logged.' })
    const checked = normalizeApiKey(raw)
    if (!checked.ok) {
      surface.addNotice(checked.reason === 'empty' ? 'API key cannot be empty.' : 'API key contains unsupported characters.', 'error')
      return { handled: true }
    }
    await ctx.credentials.set(ref, checked.value)
    surface.addNotice('DeepSeek API key stored. New requests use it immediately.', 'command')
    surface.setIdentity(await identityFor(ctx, config, live))
    return { handled: true }
  }
  if (command === 'logout') {
    const ref = selectedCredentialRef(ctx, live)
    if (ref === undefined) {
      surface.addNotice('The selected provider does not expose a managed API-key credential.', 'error')
      return { handled: true }
    }
    const info = await ctx.credentials.describe(ref)
    if (!info.writable) {
      surface.addNotice(`${String(ref)} is supplied read-only by ${info.source ?? 'the environment'} and cannot be removed here.`, 'error')
      return { handled: true }
    }
    await ctx.credentials.unset(ref)
    const remaining = await ctx.credentials.describe(ref)
    surface.addNotice(remaining.configured
      ? `Managed API key removed, but ${String(ref)} is still supplied by ${remaining.source ?? 'another source'}.`
      : 'Managed API key removed.', 'command')
    surface.setIdentity(await identityFor(ctx, config, live))
    return { handled: true }
  }
  if (command === 'status') {
    const identity = await identityFor(ctx, config, live)
    surface.addNotice([
      `Session: ${identity.sessionId}`,
      `Model: ${identity.provider}/${identity.model}${identity.reasoningEffort === undefined ? '' : ` (${identity.reasoningEffort})`}`,
      `Authentication: ${identity.authenticated ? `configured${identity.credentialSource === undefined ? '' : ` via ${identity.credentialSource}`}` : 'missing'}`,
      `Workspace: ${identity.cwd}`,
    ].join('\n'), 'command')
    return { handled: true }
  }
  if (command === 'models') {
    const lines: string[] = []
    const current = live.selection.current
    for (const provider of ctx.llm.listProviders()) {
      lines.push(`${provider.name} (${provider.id})`)
      try {
        for (const model of await ctx.llm.listModels(provider.id)) {
          const marker = current?.provider === provider.id && current.model === model.id ? '*' : ' '
          try {
            const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
            const efforts = info.reasoning?.efforts.map(entry => String(entry.id)).join('/')
            lines.push(` ${marker} ${model.id} — ${model.name}${efforts === undefined || efforts === '' ? '' : ` · reasoning ${efforts}`}`)
          } catch (error) {
            lines.push(` ${marker} ${model.id} — ${model.name} · metadata unavailable: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } catch (error) {
        lines.push(`  unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    surface.addNotice(lines.join('\n') || 'No registered model providers.', 'command')
    return { handled: true }
  }
  if (command === 'model') {
    const current = live.selection.current
    if (current === undefined) throw new Error('CLI session has no selected model')
    const selected = await chooseModel(ctx, surface, rawInput)
    if (selected === undefined) return { handled: true }
    live.selection.current = selected
    try {
      await ctx.agentDefaultModel.saveSelection(selected)
    } catch (error) {
      surface.addNotice(`Model changed for this session, but saving the default failed: ${String(error)}`, 'error')
    }
    surface.setIdentity(await identityFor(ctx, config, live))
    surface.addNotice(`Model selected: ${selected.provider}/${selected.model}${selected.reasoningEffort === undefined ? '' : ` · ${String(selected.reasoningEffort)}`}`, 'command')
    return { handled: true }
  }
  if (command === 'sessions') {
    const sessions = (await ctx.sessionPersistence.list())
      .filter(header => header.origin !== 'subagent' && header.cwd === config.cwd)
      .sort((left, right) => right.createdAt - left.createdAt)
    surface.addNotice(sessions.length === 0
      ? 'No persisted sessions.'
      : sessions.map(header => sessionLine(header, String(live.handle.agent.id))).join('\n'), 'command')
    return { handled: true }
  }
  if (command === 'new') {
    const replacement = await createFresh(ctx, config.cwd)
    surface.addNotice(`Started fresh session ${String(replacement.handle.agent.id)}.`, 'command')
    return { handled: true, live: replacement }
  }
  if (command === 'resume') {
    let id = rawInput.trim()
    if (id === '') {
      const sessions = (await ctx.sessionPersistence.list())
        .filter(header => header.origin !== 'subagent'
          && header.cwd === config.cwd
          && String(header.id) !== String(live.handle.agent.id))
        .sort((left, right) => right.createdAt - left.createdAt)
      if (sessions.length === 0) {
        surface.addNotice('No other persisted sessions to resume.', 'error')
        return { handled: true }
      }
      const options = sessions.map(header => `${String(header.id)} — ${new Date(header.createdAt).toLocaleString()} — ${header.cwd ?? '<no cwd>'}`)
      const answer = await surface.ask({ kind: 'question', label: 'Resume a session', options })
      id = (optionByNumber(options.map(label => ({ label })), answer)?.label ?? answer).split(' — ')[0] ?? ''
    }
    if (id === String(live.handle.agent.id)) {
      surface.addNotice('That session is already active.', 'error')
      return { handled: true }
    }
    const replacement = await resumeSession(ctx, id, config.cwd)
    surface.addNotice(`Resumed session ${id}.`, 'command')
    return { handled: true, live: replacement }
  }
  return { handled: true }
}

/** Report a terminal driver failure and request failing process exit. */
function fail(io: CliIo, error: unknown): void {
  io.stderr.write(`deepseek: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/** Run the complete interactive loop. */
async function run(ctx: Context, config: Config, io: CliIo): Promise<void> {
  await ctx.get('loader')?.await()
  if (ctx.get('agents') === undefined || ctx.get('sessions') === undefined) return
  let live = await createFresh(ctx, config.cwd)
  const terminal = internals.terminal ?? Boolean((internals.stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY)
  const surface = createCliSurface({
    stdin: internals.stdin,
    stdout: internals.stdout,
    stderr: internals.stderr,
    terminal,
    identity: await identityFor(ctx, config, live),
  })
  let stopRendering: (() => void) | undefined
  let stopApproval: (() => void) | undefined
  let stopQuestions: (() => void) | undefined
  let stopCommands: (() => void) | undefined
  let stopSubagentStart: (() => void) | undefined
  let stopSubagentEnd: (() => void) | undefined
  let activeCommand: AbortController | undefined
  let trackedUsageSessions = new Set([String(live.handle.agent.session.id)])
  const usageBySession = new Map<string, CliUsageStatus>()
  try {
    const publishUsage = (): void => {
      const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
      for (const usage of usageBySession.values()) {
        totals.uncachedInputTokens += usage.uncachedInputTokens
        totals.cacheReadTokens += usage.cacheReadTokens
        totals.cacheWriteTokens += usage.cacheWriteTokens
        totals.outputTokens += usage.outputTokens
      }
      surface.setUsage(totals)
    }
    const refreshUsage = (session: Agent['session']): void => {
      if (!trackedUsageSessions.has(String(session.id))) return
      const values = ctx.get('sessionProjections')?.snapshot(session).values as
        | Partial<Record<'usageLedger', CliUsageStatus>>
        | undefined
      const usage = values?.usageLedger
      if (usage === undefined) return
      usageBySession.set(String(session.id), usage)
      publishUsage()
    }
    const resetUsageRoot = (): void => {
      trackedUsageSessions = new Set([String(live.handle.agent.session.id)])
      usageBySession.clear()
      surface.setUsage({
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      })
      refreshUsage(live.handle.agent.session)
    }
    const render = (session: Agent['session'], event: SessionEvent): void => {
      refreshUsage(session)
      if (session !== live.handle.agent.session) return
      renderSessionEvent(surface, live, event)
    }
    stopRendering = ctx.on('session/event', render)
    stopSubagentStart = ctx.on('subagent/start', (info) => {
      surface.startBackgroundTask(String(info.runId))
      trackedUsageSessions.add(String(info.id))
      const child = ctx.agents.get(info.id)
      if (child !== undefined) refreshUsage(child.session)
    })
    stopSubagentEnd = ctx.on('subagent/end', (info) => { surface.endBackgroundTask(String(info.runId)) })
    stopApproval = ctx.on('approval/request', (request, next) => {
      if (request.agent !== live.handle.agent) return next()
      return answerApproval(surface, request)
    })
    stopQuestions = ctx.userQuestions.registerProvider({
      async ask(request) {
        if (request.agent !== live.handle.agent) {
          throw new UserQuestionError(
            'the CLI question provider only serves its own live root agent',
            request.agent === undefined ? 'CALLER_NOT_LIVE' : 'DELEGATED_CALLER',
          )
        }
        return answerQuestions(surface, request)
      },
    })
    const refreshCommands = (): void => {
      surface.setCommandNames([...BUILTIN_COMMANDS, ...ctx.commands.list(live.handle.agent).map(command => command.name)])
    }
    refreshCommands()
    resetUsageRoot()
    stopCommands = ctx.on('commands/change', refreshCommands)
    surface.onCancel(() => {
      if (live.handle.agent.status === 'running') live.handle.agent.cancel({ kind: 'user' })
      else if (activeCommand !== undefined) activeCommand.abort(new Error('command cancelled by user'))
      else surface.close()
    })
    await live.handle.agent.whenIdle()
    while (!surface.isClosed) {
      let line: string
      try {
        line = await surface.ask({ kind: 'chat', label: CHAT_PROMPT_LABEL })
      } catch (error) {
        if (isSurfaceClosed(error, surface)) break
        throw error
      }
      const text = line.trim()
      if (text === '') continue
      try {
        const builtin = await executeBuiltin(ctx, config, surface, live, text)
        if (builtin.exit === true) break
        if (builtin.live !== undefined) {
          const previous = live
          live = builtin.live
          await ctx.sessions.flush(previous.handle.agent.session)
          await previous.handle.dispose()
          surface.setIdentity(await identityFor(ctx, config, live))
          resetUsageRoot()
          refreshCommands()
        }
        if (builtin.handled) {
          await ctx.sessions.flush(live.handle.agent.session)
          continue
        }
        if (text.startsWith('/')) {
          const controller = new AbortController()
          activeCommand = controller
          surface.setRunning(true)
          const execution = await ctx.commands.execute(live.handle.agent, text, controller.signal)
          if (execution !== undefined) {
            if (execution.result.text !== undefined) {
              surface.addNotice(execution.result.text, execution.result.kind === 'error' ? 'error' : 'command')
            }
            await ctx.sessions.flush(live.handle.agent.session)
            continue
          }
          surface.addNotice(`Unknown command: ${text.split(/\s/u)[0] ?? text}. Run /help.`, 'error')
          continue
        }
        surface.setRunning(true)
        live.handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
        await live.handle.agent.whenIdle()
        await ctx.sessions.flush(live.handle.agent.session)
      } catch (error) {
        surface.addNotice(error instanceof Error ? error.message : String(error), 'error')
      } finally {
        activeCommand = undefined
        surface.setRunning(false)
      }
    }
  } finally {
    stopSubagentEnd?.()
    stopSubagentStart?.()
    stopCommands?.()
    stopQuestions?.()
    stopApproval?.()
    stopRendering?.()
    surface.close()
    await live.handle.agent.whenIdle()
    await ctx.sessions.flush(live.handle.agent.session)
    await live.handle.dispose()
  }
  io.exit(0)
}

/** Mount the local CLI driver. */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('cli-runner: launcher did not provide ctx.appExit')
  const io: CliIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
