/**
 * Terminal presentation adapters shared by the interactive Agent driver. TTY
 * sessions use Ink; pipes and dumb terminals retain deterministic plain text.
 * @module @deepseek-ai/dsh-cli-app/surface
 */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { CliInput } from './input.ts'
import { TerminalTui, TuiClosedError } from './tui.ts'
import type { TuiIdentity, TuiPrompt } from './tui.ts'

/** Presentation facts the driver may update without exposing secret values. */
export type CliIdentity = TuiIdentity

/** Constructor streams shared by both presentation adapters. */
export interface CliSurfaceOptions {
  readonly stdin: NodeJS.ReadableStream
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly terminal: boolean
  readonly identity: CliIdentity
}

/** One terminal UI over Agent, approval, question, and command interactions. */
export interface CliSurface {
  readonly rich: boolean
  readonly closed: Promise<void>
  readonly isClosed: boolean
  setIdentity(identity: CliIdentity): void
  setCommandNames(names: readonly string[]): void
  setRunning(running: boolean): void
  onCancel(handler: () => void): void
  ask(prompt: TuiPrompt, signal?: AbortSignal): Promise<string>
  addUser(text: string): void
  addNotice(text: string, kind?: 'notice' | 'error' | 'command'): void
  addTool(text: string, detail?: string, failed?: boolean): void
  appendAssistant(text: string): void
  fallbackAssistant(text: string): void
  endAssistant(reason?: TurnEndReason): void
  clear(): void
  close(): void
}

/** Plain readline fallback: stable text and zero ANSI for pipes and CI. */
class PlainCliSurface implements CliSurface {
  readonly rich = false
  private readonly input: CliInput

  constructor(private readonly options: CliSurfaceOptions) {
    this.input = new CliInput({
      input: options.stdin,
      output: options.stdout,
      terminal: false,
    })
  }

  get closed(): Promise<void> { return this.input.closed }
  get isClosed(): boolean { return this.input.isClosed }
  setIdentity(_identity: CliIdentity): void {}
  setCommandNames(_names: readonly string[]): void {}
  setRunning(_running: boolean): void {}
  onCancel(handler: () => void): void { this.input.onSigint(handler) }

  ask(prompt: TuiPrompt, signal?: AbortSignal): Promise<string> {
    if (prompt.detail !== undefined) this.options.stdout.write(`${prompt.detail}\n`)
    if (prompt.options !== undefined) {
      for (const [index, option] of prompt.options.entries()) {
        this.options.stdout.write(`${index + 1}) ${option}\n`)
      }
    }
    const label = prompt.kind === 'chat' ? '> ' : `${prompt.label}: `
    return this.input.ask(label, signal)
  }

  addUser(_text: string): void {}
  addNotice(text: string, _kind: 'notice' | 'error' | 'command' = 'notice'): void {
    this.options.stdout.write(`${text}\n`)
  }
  addTool(text: string, detail?: string, _failed = false): void {
    this.options.stdout.write(`[tool] ${text}${detail === undefined ? '' : ` ${detail}`}\n`)
  }
  appendAssistant(text: string): void {
    this.options.stdout.write(text)
  }
  fallbackAssistant(text: string): void {
    this.options.stdout.write(text)
  }
  endAssistant(reason?: TurnEndReason): void {
    if (reason?.kind === 'error') this.options.stdout.write(`\n[error] ${reason.error.message}`)
    else if (reason !== undefined && reason.kind !== 'completed') this.options.stdout.write(`\n[${reason.kind}]`)
    this.options.stdout.write('\n')
  }
  clear(): void {}
  close(): void { this.input.close() }
}

/** Rich non-full-screen adapter around one Ink tree. */
class RichCliSurface implements CliSurface {
  readonly rich = true
  private readonly tui: TerminalTui

  constructor(options: CliSurfaceOptions) {
    this.tui = new TerminalTui({
      stdin: options.stdin as NodeJS.ReadStream,
      stdout: options.stdout as NodeJS.WriteStream,
      stderr: options.stderr as NodeJS.WriteStream,
      identity: options.identity,
    })
  }

  get closed(): Promise<void> { return this.tui.closed }
  get isClosed(): boolean { return this.tui.isClosed }
  setIdentity(identity: CliIdentity): void { this.tui.setIdentity(identity) }
  setCommandNames(names: readonly string[]): void { this.tui.setCommandNames(names) }
  setRunning(running: boolean): void { this.tui.setRunning(running) }
  onCancel(handler: () => void): void { this.tui.onCancel(handler) }
  ask(prompt: TuiPrompt, signal?: AbortSignal): Promise<string> { return this.tui.ask(prompt, signal) }
  addUser(text: string): void { this.tui.addUser(text) }
  addNotice(text: string, kind: 'notice' | 'error' | 'command' = 'notice'): void {
    this.tui.addNotice(text, kind)
  }
  addTool(text: string, detail?: string, failed = false): void { this.tui.addTool(text, detail, failed) }
  appendAssistant(text: string): void { this.tui.appendAssistant(text) }
  fallbackAssistant(text: string): void { this.tui.fallbackAssistant(text) }
  endAssistant(reason?: TurnEndReason): void {
    this.tui.endAssistant()
    if (reason === undefined || reason.kind === 'completed') return
    if (reason.kind === 'error') this.tui.addNotice(reason.error.message, 'error')
    else if (reason.kind === 'aborted') this.tui.addNotice('Turn cancelled.')
    else if (reason.kind === 'max-tokens') this.tui.addNotice('Turn stopped at the model output limit.')
    else this.tui.addNotice(`Turn ended: ${reason.kind}.`)
  }
  clear(): void { this.tui.clear() }
  close(): void { this.tui.close() }
}

/**
 * Create the one adapter owning stdin and terminal rendering.
 * @param options - Process streams, terminal mode, and initial runtime identity.
 * @returns the rich TTY surface or deterministic plain-stream surface.
 */
export function createCliSurface(options: CliSurfaceOptions): CliSurface {
  return options.terminal ? new RichCliSurface(options) : new PlainCliSurface(options)
}

/**
 * Determine whether a prompt failure means the surface was intentionally closed.
 * @param error - Failure raised while reading from the surface.
 * @param surface - Surface whose current lifecycle state is authoritative.
 * @returns true when shutdown, EOF, or explicit close ended the prompt.
 */
export function isSurfaceClosed(error: unknown, surface: CliSurface): boolean {
  return surface.isClosed || error instanceof TuiClosedError
}
