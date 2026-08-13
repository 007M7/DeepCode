/**
 * Ink-backed local terminal surface. It keeps the terminal scrollback instead
 * of taking the alternate screen, owns raw stdin through one `useInput` hook,
 * and exposes promise-based prompts to the framework-neutral Agent driver.
 * @module @deepseek-ai/dsh-cli-app/tui
 */

import { EventEmitter } from 'node:events'
import React, { useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Box, Text, render, useInput } from 'ink'
import type { Instance, Key } from 'ink'

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
  readonly items: readonly TuiItem[]
  readonly activeAssistant: string
  readonly prompt: TuiPrompt | undefined
  readonly buffer: string
  readonly cursor: number
  readonly selected: number
  readonly running: boolean
  readonly toolDetails: boolean
  readonly commandNames: readonly string[]
}

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
  readonly unicode: boolean
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
  private readonly instance: Instance
  private readonly unicode: boolean
  private readonly stdin: NodeJS.ReadStream
  private readonly closeOnEnd = (): void => { this.close() }

  constructor(options: TerminalTuiOptions) {
    this.unicode = options.unicode
    this.stdin = options.stdin
    this.snapshotValue = {
      identity: options.identity,
      items: [],
      activeAssistant: '',
      prompt: undefined,
      buffer: '',
      cursor: 0,
      selected: 0,
      running: false,
      toolDetails: false,
      commandNames: [],
    }
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve })
    this.instance = render(h(TuiRoot, { tui: this, unicode: this.unicode }), {
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    })
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
    this.update({ running })
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
    if (text !== '') this.addItem('assistant', text)
    this.update({ activeAssistant: '' })
  }

  /** Remove the current terminal rendering and retained transcript. */
  clear(): void {
    this.instance.clear()
    this.update({ items: [], activeAssistant: '' })
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
    this.historyIndex = this.history.length
    this.update({ prompt, buffer: '', cursor: 0, selected: 0 })
    return new Promise<string>((resolve, reject) => {
      const pending: PendingPrompt = { resolve, reject, ...signal === undefined ? {} : { signal } }
      if (signal !== undefined) {
        const abort = (): void => {
          if (this.pending !== pending) return
          this.pending = undefined
          this.update({ prompt: undefined, buffer: '', cursor: 0, selected: 0 })
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
    const item: TuiItem = {
      id: this.nextItemId++, kind, text,
      ...detail === undefined ? {} : { detail },
      ...failed === undefined ? {} : { failed },
    }
    this.update({ items: [...this.snapshotValue.items, item] })
  }

  private update(patch: Partial<TuiSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    this.events.emit('change')
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
    if (prompt === undefined || pending === undefined) return
    this.pending = undefined
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort)
    }
    if (prompt.kind === 'chat' && value.trim() !== '') {
      this.history.push(value)
      this.historyIndex = this.history.length
      this.addUser(value)
    }
    this.update({ prompt: undefined, buffer: '', cursor: 0, selected: 0 })
    pending.resolve(value)
  }
}

/** Root Ink component: permanent transcript above one live status/composer. */
function TuiRoot({ tui, unicode }: { readonly tui: TerminalTui; readonly unicode: boolean }): ReactElement {
  const state = useSyncExternalStore(tui.subscribe, tui.getSnapshot, tui.getSnapshot)
  useInput((input, key) => { tui.handleInput(input, key) })
  return h(Box, { flexDirection: 'column' },
    h(WelcomeCard, { identity: state.identity, unicode }),
    h(Box, { flexDirection: 'column' }, ...state.items.map((item: TuiItem) =>
      h(TranscriptItem, {
        key: item.id,
        item,
        toolDetails: state.toolDetails,
      }))),
    state.activeAssistant === '' ? null : h(Box, { marginTop: 1 },
      h(Text, { color: BLUE, bold: true }, '◆ '),
      h(Text, null, state.activeAssistant),
    ),
    state.running && state.activeAssistant === '' ? h(Box, { marginTop: 1 },
      h(Text, { color: BLUE }, '● '), h(Text, { dimColor: true }, 'DeepSeek is working…  Esc/Ctrl+C to cancel'),
    ) : null,
    state.prompt === undefined ? null : h(Composer, { state }),
    h(StatusLine, { state }),
  )
}

/** Branded welcome card with a blue pixel whale and current runtime facts. */
function WelcomeCard({ identity, unicode }: { readonly identity: TuiIdentity; readonly unicode: boolean }): ReactElement {
  const whale = unicode
    ? [
      { body: '              ▄▄▄    ▄▄' },
      { body: '        ▄▄   █████  ███' },
      { body: '   ▄████████▄████████▀' },
      { body: ' ▄██████████ ', eye: '●', tail: ' ███▀' },
      { body: '  ▀███████████████▀' },
      { body: '    ▀▀█████████▀▀' },
      { body: '       ▀▀▀▀▀' },
    ]
    : [
      { body: '              ___    __' },
      { body: '        __   /   \\  /  \\' },
      { body: '   ____/  \\_/    \\/  _/' },
      { body: ' /           (', eye: 'o', tail: ')  /' },
      { body: ' \\_______________/' },
      { body: '    \\_________/' },
      { body: '       -----' },
    ]
  const model = `${identity.provider}/${identity.model}${identity.reasoningEffort === undefined ? '' : ` · ${identity.reasoningEffort}`}`
  const auth = identity.authenticated
    ? `authenticated${identity.credentialSource === undefined ? '' : ` via ${identity.credentialSource}`}`
    : 'not authenticated · run /login'
  return h(Box, { borderStyle: 'round', borderColor: BLUE, paddingX: 1, marginBottom: 1 },
    h(Box, { flexDirection: 'column', marginRight: 2 }, ...whale.map((line, index) =>
      h(Box, { key: index },
        h(Text, { color: BLUE, bold: true }, line.body),
        line.eye === undefined ? null : h(Text, { color: '#FFFFFF', bold: true }, line.eye),
        line.tail === undefined ? null : h(Text, { color: BLUE, bold: true }, line.tail),
      ))),
    h(Box, { flexDirection: 'column', justifyContent: 'center', flexGrow: 1 },
      h(Text, { color: PALE_BLUE, bold: true }, 'DeepSeek Harness'),
      h(Text, { dimColor: true }, `Local Agent CLI · v${identity.version}`),
      h(Text, null, model),
      h(Text, { color: identity.authenticated ? GOOD : '#E6B450' }, auth),
      h(Text, { color: MUTED, wrap: 'truncate-middle' }, identity.cwd),
    ),
  )
}

/** One permanent transcript row. */
function TranscriptItem({ item, toolDetails }: { readonly item: TuiItem; readonly toolDetails: boolean }): ReactElement {
  const icon = item.kind === 'user' ? '›'
    : item.kind === 'assistant' ? '◆'
      : item.kind === 'tool' ? (item.failed ? '✗' : '◈')
        : item.kind === 'error' ? '!' : item.kind === 'command' ? '/' : '•'
  const color = item.kind === 'error' || item.failed ? BAD
    : item.kind === 'assistant' || item.kind === 'tool' ? BLUE
      : item.kind === 'user' ? PALE_BLUE : MUTED
  const detail: ReactNode = toolDetails && item.detail !== undefined
    ? h(Box, { marginLeft: 2 }, h(Text, { dimColor: true }, item.detail))
    : null
  return h(Box, { flexDirection: 'column', marginTop: item.kind === 'assistant' || item.kind === 'user' ? 1 : 0 },
    h(Box, null, h(Text, { color, bold: true }, `${icon} `), h(Text, null, item.text)),
    detail,
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
    ? 'Esc/Ctrl+C cancel · Ctrl+O tool details'
    : 'Enter send · Ctrl+J newline · ↑↓ history · Tab complete · Ctrl+N new · Ctrl+C exit'
  return h(Box, { justifyContent: 'space-between' },
    h(Text, { color: state.running ? '#E6B450' : GOOD }, `● ${mode}`),
    h(Text, { color: MUTED }, shortcut),
  )
}
