/**
 * Ink-backed local terminal surface. It keeps the terminal scrollback instead
 * of taking the alternate screen, owns raw stdin through one `useInput` hook,
 * and exposes promise-based prompts to the framework-neutral Agent driver.
 * @module @deepseek-ai/dsh-cli-app/tui
 */

import { EventEmitter } from 'node:events'
import React, { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Box, Static, Text, render, useInput } from 'ink'
import type { Instance, Key } from 'ink'
import { PRODUCT_NAME, WORKING_LABEL } from './brand.ts'

const h = React.createElement
const BLUE = '#4D8DFF'
const PALE_BLUE = '#8CB4FF'
const MUTED = '#7F8EA3'
const GOOD = '#58C98D'
const BAD = '#FF6B6B'

/** A durable line already committed to terminal scrollback. */
export interface TuiItem {
  readonly id: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error' | 'command'
  readonly text: string
  readonly detail?: string
  readonly failed?: boolean
}

/** One prompt temporarily owning the composer. */
export interface TuiPrompt {
  readonly kind: 'chat' | 'secret' | 'approval' | 'question'
  readonly label: string
  readonly detail?: string
  readonly options?: readonly string[]
  readonly multiSelect?: boolean
}

/** Status facts displayed in the welcome card and footer. */
export interface TuiIdentity {
  readonly version: string
  readonly cwd: string
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly authenticated: boolean
  readonly credentialSource?: string
}

interface TuiSnapshot {
  readonly identity: TuiIdentity
  readonly staticOutputs: readonly TuiStaticOutput[]
  readonly staticGeneration: number
  readonly activeAssistant: string
  readonly prompt: TuiPrompt | undefined
  readonly buffer: string
  readonly cursor: number
  readonly selected: number
  readonly running: boolean
  readonly toolDetails: boolean
  readonly commandNames: readonly string[]
  readonly queuedChats: number
}

/** One immutable output committed to terminal scrollback. */
type TuiStaticOutput =
  | { readonly id: number; readonly kind: 'welcome'; readonly identity: TuiIdentity }
  | { readonly id: number; readonly kind: 'transcript'; readonly item: TuiItem }

interface PendingPrompt {
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  readonly abort?: () => void
}

/** Options for the one Ink renderer. */
export interface TerminalTuiOptions {
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
  readonly identity: TuiIdentity
}

/** Rejection used when EOF or an explicit close withdraws a pending prompt. */
export class TuiClosedError extends Error {
  constructor() {
    super('terminal input closed before an answer arrived')
    this.name = 'TuiClosedError'
  }
}

/**
 * Imperative bridge between the Agent driver and the single React/Ink tree.
 * Every state update replaces the immutable snapshot before notifying React.
 */
export class TerminalTui {
  private readonly events = new EventEmitter()
  private readonly history: string[] = []
  private historyIndex = 0
  private nextItemId = 1
  private snapshotValue: TuiSnapshot
  private pending: PendingPrompt | undefined
  private closedFlag = false
  private resolveClosed!: () => void
  private readonly closedPromise: Promise<void>
  private cancelHandler: (() => void) | undefined
  private readonly queuedChats: string[] = []
  private lastChatPrompt: TuiPrompt | undefined
  private instance: Instance
  private readonly stdin: NodeJS.ReadStream
  private readonly stdout: NodeJS.WriteStream
  private readonly stderr: NodeJS.WriteStream
  private readonly closeOnEnd = (): void => { this.close() }

  constructor(options: TerminalTuiOptions) {
    this.stdin = options.stdin
    this.stdout = options.stdout
    this.stderr = options.stderr
    this.snapshotValue = {
      identity: options.identity,
      staticOutputs: [{ id: this.nextItemId++, kind: 'welcome', identity: options.identity }],
      staticGeneration: 0,
      activeAssistant: '',
      prompt: undefined,
      buffer: '',
      cursor: 0,
      selected: 0,
      running: false,
      toolDetails: false,
      commandNames: [],
      queuedChats: 0,
    }
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve })
    this.instance = this.renderRoot()
    this.stdin.once('end', this.closeOnEnd)
    this.stdin.once('close', this.closeOnEnd)
  }

  /** Subscribe React to immutable snapshot replacements. */
  subscribe = (listener: () => void): (() => void) => {
    this.events.on('change', listener)
    return () => { this.events.off('change', listener) }
  }

  /** Read the current immutable view snapshot. */
  getSnapshot = (): TuiSnapshot => this.snapshotValue

  /**
   * Update the welcome/footer identity after session, model, or auth changes.
   * @param identity - Current session, model, workspace, and authentication facts.
   */
  setIdentity(identity: TuiIdentity): void {
    this.update({ identity })
  }

  /**
   * Publish the effective slash-command names used by Tab completion.
   * @param names - Built-in and plugin command names without the leading slash.
   */
  setCommandNames(names: readonly string[]): void {
    this.update({ commandNames: [...new Set(names)].sort() })
  }

  /**
   * Mark whether the Agent currently owns an active turn.
   * @param running - Whether Escape and Ctrl+C should cancel active work.
   */
  setRunning(running: boolean): void {
    const backgroundPrompt = running && this.pending === undefined
      ? this.lastChatPrompt
      : this.snapshotValue.prompt
    this.update({ running, prompt: backgroundPrompt })
  }

  /**
   * Register the driver's Ctrl+C/Escape cancellation action.
   * @param handler - Single cancellation callback owned by the Agent driver.
   */
  onCancel(handler: () => void): void {
    if (this.cancelHandler !== undefined) throw new Error('TerminalTui.onCancel: handler already registered')
    this.cancelHandler = handler
  }

  /**
   * Add one human message to permanent scrollback.
   * @param text - Submitted user content.
   */
  addUser(text: string): void {
    this.addItem('user', text)
  }

  /**
   * Add a local command result or status notice.
   * @param text - Notice content retained in terminal scrollback.
   * @param kind - Visual severity and transcript role.
   */
  addNotice(text: string, kind: 'notice' | 'error' | 'command' = 'notice'): void {
    this.addItem(kind, text)
  }

  /**
   * Add a pending or settled tool line.
   * @param text - Compact tool status shown by default.
   * @param detail - Optional arguments or failure detail revealed by Ctrl+O.
   * @param failed - Whether to render the row as a failed tool operation.
   */
  addTool(text: string, detail?: string, failed = false): void {
    this.addItem('tool', text, detail, failed)
  }

  /**
   * Append one durable assistant text delta to the live response.
   * @param text - Logged text delta for the active turn.
   */
  appendAssistant(text: string): void {
    this.update({ activeAssistant: this.snapshotValue.activeAssistant + text })
  }

  /**
   * Supply an assembled fallback only when no text delta was rendered.
   * @param text - Logged assembled assistant text.
   */
  fallbackAssistant(text: string): void {
    this.update({ activeAssistant: this.snapshotValue.activeAssistant + text })
  }

  /** Commit the live assistant response to scrollback at a turn boundary. */
  endAssistant(): void {
    const text = this.snapshotValue.activeAssistant
    if (text === '') return
    const item = this.createItem('assistant', text)
    this.update({
      activeAssistant: '',
      staticOutputs: [...this.snapshotValue.staticOutputs, {
        id: item.id, kind: 'transcript', item,
      }],
    })
  }

  /** Remove the current terminal rendering and retained transcript. */
  clear(): void {
    this.instance.unmount()
    this.stdout.write('\u001B[2J\u001B[3J\u001B[H')
    this.update({
      staticOutputs: [{ id: this.nextItemId++, kind: 'welcome', identity: this.snapshotValue.identity }],
      staticGeneration: this.snapshotValue.staticGeneration + 1,
      activeAssistant: '',
      toolDetails: false,
    })
    this.instance = this.renderRoot()
  }

  /**
   * Ask one serialized terminal question. The same composer serves chat,
   * secrets, approvals, and model questions; a second prompt fails loud.
   * @param prompt - Prompt label, input kind, and optional selectable choices.
   * @param signal - Cancellation for the pending question.
   * @returns the submitted unmasked input.
   */
  ask(prompt: TuiPrompt, signal?: AbortSignal): Promise<string> {
    if (this.closedFlag) return Promise.reject(new TuiClosedError())
    if (this.pending !== undefined) return Promise.reject(new Error('TerminalTui.ask: prompt already pending'))
    signal?.throwIfAborted()
    if (prompt.kind === 'chat') {
      this.lastChatPrompt = prompt
      const queued = this.queuedChats.shift()
      if (queued !== undefined) {
        this.update({ queuedChats: this.queuedChats.length, prompt: undefined })
        return Promise.resolve(queued)
      }
    }
    this.historyIndex = this.history.length
    this.update({ prompt, buffer: '', cursor: 0, selected: 0 })
    return new Promise<string>((resolve, reject) => {
      const pending: PendingPrompt = { resolve, reject, ...signal === undefined ? {} : { signal } }
      if (signal !== undefined) {
        const abort = (): void => {
          if (this.pending !== pending) return
          this.pending = undefined
          this.update({
            prompt: this.snapshotValue.running ? this.lastChatPrompt : undefined,
            buffer: '', cursor: 0, selected: 0,
          })
          reject(signal.reason instanceof Error ? signal.reason : new Error('terminal prompt aborted'))
        }
        signal.addEventListener('abort', abort, { once: true })
        Object.assign(pending, { abort })
      }
      this.pending = pending
    })
  }

  /** EOF/exit settlement for the runner. */
  get closed(): Promise<void> { return this.closedPromise }

  /** Whether the TUI has stopped accepting input. */
  get isClosed(): boolean { return this.closedFlag }

  /** Close raw input, settle the pending prompt, and unmount Ink. */
  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.stdin.off('end', this.closeOnEnd)
    this.stdin.off('close', this.closeOnEnd)
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      if (pending.signal !== undefined && pending.abort !== undefined) {
        pending.signal.removeEventListener('abort', pending.abort)
      }
      pending.reject(new TuiClosedError())
    }
    this.resolveClosed()
    this.instance.unmount()
  }

  /**
   * Handle one key event from the root component's `useInput` subscription.
   * @param input - Printable text delivered with the key event.
   * @param key - Ink key modifiers and navigation flags.
   */
  handleInput(input: string, key: Key): void {
    const prompt = this.snapshotValue.prompt
    if (key.ctrl && input.toLowerCase() === 'c') {
      if (this.snapshotValue.running) this.cancelHandler?.()
      else this.close()
      return
    }
    if (key.escape) {
      if (this.snapshotValue.running) this.cancelHandler?.()
      else if (this.snapshotValue.buffer !== '') this.update({ buffer: '', cursor: 0 })
      return
    }
    if (key.ctrl && input.toLowerCase() === 'l') {
      this.clear()
      return
    }
    if (key.ctrl && input.toLowerCase() === 'o') {
      this.update({ toolDetails: !this.snapshotValue.toolDetails })
      return
    }
    if (prompt === undefined) return
    if (key.ctrl && input.toLowerCase() === 'n' && prompt.kind === 'chat' && !this.snapshotValue.running) {
      this.submit('/new')
      return
    }
    if (key.ctrl && input.toLowerCase() === 'd' && this.snapshotValue.buffer === '') {
      this.close()
      return
    }
    if (key.tab && prompt.kind === 'chat') {
      this.completeCommand()
      return
    }
    if (key.upArrow || key.downArrow) {
      if ((prompt.options?.length ?? 0) > 0 && !prompt.multiSelect && this.snapshotValue.buffer === '') {
        const count = prompt.options?.length ?? 0
        const movement = key.upArrow ? -1 : 1
        this.update({ selected: (this.snapshotValue.selected + movement + count) % count })
      } else if (prompt.kind === 'chat' && !this.snapshotValue.buffer.includes('\n')) {
        this.moveHistory(key.upArrow ? -1 : 1)
      }
      return
    }
    if (key.leftArrow) {
      this.update({ cursor: Math.max(0, this.snapshotValue.cursor - 1) })
      return
    }
    if (key.rightArrow) {
      this.update({ cursor: Math.min(this.snapshotValue.buffer.length, this.snapshotValue.cursor + 1) })
      return
    }
    // Ink 5 reports the DEL byte emitted by Windows CMD's Backspace key as
    // `delete`. Treat both names as backward deletion so the primary editing
    // key works consistently across Windows and POSIX terminals.
    if (key.backspace || key.delete) {
      if (this.snapshotValue.cursor === 0) return
      const { buffer, cursor } = this.snapshotValue
      this.update({ buffer: buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor: cursor - 1 })
      return
    }
    if (key.ctrl) {
      const lower = input.toLowerCase()
      if (lower === 'a') { this.update({ cursor: 0 }); return }
      if (lower === 'e') { this.update({ cursor: this.snapshotValue.buffer.length }); return }
      if (lower === 'u') {
        this.update({ buffer: this.snapshotValue.buffer.slice(this.snapshotValue.cursor), cursor: 0 })
        return
      }
      if (lower === 'k') {
        this.update({ buffer: this.snapshotValue.buffer.slice(0, this.snapshotValue.cursor) })
        return
      }
      if (lower === 'w') { this.deletePreviousWord(); return }
      if (lower === 'j' || input === '\n') { this.insert('\n'); return }
      return
    }
    if (key.return) {
      if (key.shift && prompt.kind === 'chat') this.insert('\n')
      else if (this.snapshotValue.buffer !== '') this.submit(this.snapshotValue.buffer)
      else if ((prompt.options?.length ?? 0) > 0 && !prompt.multiSelect) {
        this.submit(prompt.options?.[this.snapshotValue.selected] ?? '')
      } else if (prompt.kind !== 'chat') this.submit('')
      return
    }
    if (input.length > 0 && !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(input)) this.insert(input)
  }

  private addItem(kind: TuiItem['kind'], text: string, detail?: string, failed?: boolean): void {
    const item = this.createItem(kind, text, detail, failed)
    this.update({
      staticOutputs: [...this.snapshotValue.staticOutputs, {
        id: item.id, kind: 'transcript', item,
      }],
    })
  }

  private createItem(kind: TuiItem['kind'], text: string, detail?: string, failed?: boolean): TuiItem {
    return {
      id: this.nextItemId++, kind, text,
      ...detail === undefined ? {} : { detail },
      ...failed === undefined ? {} : { failed },
    }
  }

  private update(patch: Partial<TuiSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    this.events.emit('change')
  }

  /** Create one Ink owner for the current terminal state. */
  private renderRoot(): Instance {
    return render(h(TuiRoot, { tui: this }), {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    })
  }

  private insert(text: string): void {
    const { buffer, cursor } = this.snapshotValue
    this.update({ buffer: buffer.slice(0, cursor) + text + buffer.slice(cursor), cursor: cursor + text.length })
  }

  private deletePreviousWord(): void {
    const { buffer, cursor } = this.snapshotValue
    const prefix = buffer.slice(0, cursor)
    const start = prefix.search(/\S+\s*$/u)
    const cut = start < 0 ? 0 : start
    this.update({ buffer: buffer.slice(0, cut) + buffer.slice(cursor), cursor: cut })
  }

  private moveHistory(delta: number): void {
    if (this.history.length === 0) return
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta))
    const buffer = this.historyIndex === this.history.length ? '' : (this.history[this.historyIndex] ?? '')
    this.update({ buffer, cursor: buffer.length })
  }

  private completeCommand(): void {
    const { buffer, commandNames } = this.snapshotValue
    if (!buffer.startsWith('/') || /\s/u.test(buffer)) return
    const matches = commandNames.filter(name => `/${name}`.startsWith(buffer))
    if (matches.length !== 1) return
    const completed = `/${matches[0]} `
    this.update({ buffer: completed, cursor: completed.length })
  }

  private submit(value: string): void {
    const prompt = this.snapshotValue.prompt
    const pending = this.pending
    if (prompt === undefined) return
    if (pending === undefined) {
      if (prompt.kind !== 'chat' || !this.snapshotValue.running || value.trim() === '') return
      this.history.push(value)
      this.historyIndex = this.history.length
      this.queuedChats.push(value)
      this.addUser(value)
      this.update({ buffer: '', cursor: 0, selected: 0, queuedChats: this.queuedChats.length })
      return
    }
    this.pending = undefined
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort)
    }
    if (prompt.kind === 'chat' && value.trim() !== '') {
      this.history.push(value)
      this.historyIndex = this.history.length
      this.addUser(value)
    }
    this.update({
      prompt: this.snapshotValue.running && prompt.kind !== 'chat' ? this.lastChatPrompt : undefined,
      buffer: '', cursor: 0, selected: 0,
    })
    pending.resolve(value)
  }
}

/** Root Ink component: permanent transcript above one live status/composer. */
function TuiRoot({ tui }: { readonly tui: TerminalTui }): ReactElement {
  const state = useSyncExternalStore(tui.subscribe, tui.getSnapshot, tui.getSnapshot)
  useInput((input, key) => { tui.handleInput(input, key) })
  return h(Box, { flexDirection: 'column' },
    h(Static, {
      key: state.staticGeneration,
      items: [...state.staticOutputs],
      children: (value: unknown) => {
        const output = value as TuiStaticOutput
        return output.kind === 'welcome'
          ? h(WelcomeCard, { key: output.id, identity: output.identity })
          : h(TranscriptItem, { key: output.id, item: output.item })
      },
    }),
    state.activeAssistant === '' ? null : h(Box, { marginTop: 1 },
      h(Text, { color: BLUE, bold: true }, '◆ '),
      h(Text, null, state.activeAssistant),
    ),
    state.running && state.activeAssistant === '' ? h(Box, { marginTop: 1 },
      h(Text, { color: BLUE }, '● '), h(Text, { dimColor: true }, WORKING_LABEL),
    ) : null,
    state.toolDetails ? h(ToolDetailsPanel, { outputs: state.staticOutputs }) : null,
    state.prompt === undefined ? null : h(Composer, { state }),
    h(StatusLine, { state }),
  )
}

/** Compact welcome row with the current workspace and authentication state. */
function WelcomeCard({ identity }: { readonly identity: TuiIdentity }): ReactElement {
  const model = `${identity.provider}/${identity.model}${identity.reasoningEffort === undefined ? '' : ` · ${identity.reasoningEffort}`}`
  const auth = identity.authenticated
    ? `authenticated${identity.credentialSource === undefined ? '' : ` via ${identity.credentialSource}`}`
    : 'not authenticated · run /login'
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Text, null,
      h(Text, { color: PALE_BLUE, bold: true }, PRODUCT_NAME),
      h(Text, { color: MUTED }, ` v${identity.version} · `),
      h(Text, null, model),
      h(Text, { color: identity.authenticated ? GOOD : '#E6B450' }, ` · ${auth}`),
    ),
    h(Text, { color: MUTED, wrap: 'truncate-middle' }, identity.cwd),
  )
}

/** One permanent transcript row. */
function TranscriptItem({ item }: { readonly item: TuiItem }): ReactElement {
  const icon = item.kind === 'user' ? '›'
    : item.kind === 'assistant' ? '◆'
      : item.kind === 'tool' ? (item.failed ? '✗' : '◈')
        : item.kind === 'error' ? '!' : item.kind === 'command' ? '/' : '•'
  const color = item.kind === 'error' || item.failed ? BAD
    : item.kind === 'assistant' || item.kind === 'tool' ? BLUE
      : item.kind === 'user' ? PALE_BLUE : MUTED
  return h(Box, { flexDirection: 'column', marginTop: item.kind === 'assistant' || item.kind === 'user' ? 1 : 0 },
    h(Box, null, h(Text, { color, bold: true }, `${icon} `), h(Text, null, item.text)),
  )
}

/** Dynamic latest-tool detail panel; history remains immutable in `<Static>`. */
function ToolDetailsPanel({ outputs }: { readonly outputs: readonly TuiStaticOutput[] }): ReactElement | null {
  const tools = outputs.flatMap(output => output.kind === 'transcript'
    && output.item.kind === 'tool' && output.item.detail !== undefined ? [output.item] : [])
  const item = tools.at(-1)
  if (item === undefined) return null
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: MUTED, paddingX: 1, marginTop: 1 },
    h(Text, { color: PALE_BLUE, bold: true }, 'Latest tool details'),
    h(Box, { key: item.id, flexDirection: 'column' },
      h(Text, { color: item.failed ? BAD : BLUE }, `${item.failed ? '✗' : '◈'} ${item.text}`),
      h(Box, { marginLeft: 2 }, h(Text, { dimColor: true }, item.detail)),
    ),
  )
}

/** Live prompt panel, including masked secrets and selectable options. */
function Composer({ state }: { readonly state: TuiSnapshot }): ReactElement {
  const prompt = state.prompt
  if (prompt === undefined) return h(Box)
  const options = prompt.options ?? []
  const before = state.buffer.slice(0, state.cursor)
  const cursorChar = state.buffer[state.cursor] ?? ' '
  const after = state.buffer.slice(state.cursor + (state.cursor < state.buffer.length ? 1 : 0))
  const mask = (value: string): string => prompt.kind === 'secret' ? '•'.repeat(value.length) : value
  const suggestions = prompt.kind === 'chat' && state.buffer.startsWith('/') && !/\s/u.test(state.buffer)
    ? state.commandNames.filter(name => `/${name}`.startsWith(state.buffer)).slice(0, 6)
    : []
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: prompt.kind === 'secret' ? '#E6B450' : BLUE, paddingX: 1, marginTop: 1 },
    h(Text, { color: PALE_BLUE, bold: true }, prompt.label),
    prompt.detail === undefined ? null : h(Text, { dimColor: true }, prompt.detail),
    ...options.map((option, index) => h(Text, {
      key: option,
      ...index === state.selected ? { color: BLUE, bold: true } : {},
    }, `${index === state.selected ? '›' : ' '} ${index + 1}. ${option}`)),
    h(Box, null,
      h(Text, { color: BLUE, bold: true }, '> '),
      h(Text, null, mask(before)),
      h(Text, { backgroundColor: BLUE, color: 'black' }, mask(cursorChar) || ' '),
      h(Text, null, mask(after)),
    ),
    suggestions.length === 0 ? null : h(Text, { color: MUTED }, suggestions.map(name => `/${name}`).join('  ')),
  )
}

/** Compact always-visible state and shortcut row. */
function StatusLine({ state }: { readonly state: TuiSnapshot }): ReactElement {
  const mode = state.running ? 'working' : state.prompt?.kind === 'secret' ? 'login'
    : state.prompt?.kind === 'approval' ? 'approval' : state.prompt?.kind === 'question' ? 'question' : 'ready'
  const shortcut = state.running
    ? `Enter queue${state.queuedChats === 0 ? '' : ` (${state.queuedChats})`} · Esc/Ctrl+C cancel · Ctrl+O tools`
    : 'Enter send · Ctrl+J newline · ↑↓ history · Tab complete · Ctrl+N new · Ctrl+C exit'
  const model = `${state.identity.provider}/${state.identity.model}${state.identity.reasoningEffort === undefined ? '' : ` · ${state.identity.reasoningEffort}`}`
  const session = state.identity.sessionId.length > 12
    ? `${state.identity.sessionId.slice(0, 8)}…${state.identity.sessionId.slice(-4)}`
    : state.identity.sessionId
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: MUTED, wrap: 'truncate-middle' }, `${PRODUCT_NAME} · ${model} · ${state.identity.authenticated ? 'authenticated' : 'login required'} · session ${session}`),
    h(Box, { justifyContent: 'space-between' },
      h(Text, { color: state.running ? '#E6B450' : GOOD }, `● ${mode}`),
      h(Text, { color: MUTED }, shortcut),
    ),
  )
}
