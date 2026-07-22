/**
 * Plugin-owned human-command registry shared by interactive UI adapters.
 * @module @deepseek-ai/dsh-commands
 */

import { Context, Service } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NamedEntries, ScopedLayers } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'

export const name = 'commands'

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** Immutable command input metadata compatible with ACP unstructured input. */
export interface CommandInputDescriptor {
  /** Placeholder shown before the user supplies free-form input. */
  readonly hint: string
}

/** Invocation passed to one registered command handler. */
export interface CommandInvocation {
  /** Exact agent whose human-facing surface received the command. */
  readonly agent: Agent
  /** Exact text following the registered command name, including separator whitespace. */
  readonly rawInput: string
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
}

/** Expected command outcome rendered directly by the dispatching UI. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Plugin-owned command registration. */
export interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Handler-free immutable command view returned to UI adapters. */
export interface CommandDescriptor {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: CommandInputDescriptor
}

/** Syntactically valid slash command before registry resolution. */
export interface ParsedCommand {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Exact text following the command name. */
  readonly rawInput: string
}

interface RegisteredCommand {
  readonly definition: CommandDefinition
  readonly descriptor: CommandDescriptor
}

/** All command registrations owned by one global or scoped layer. */
class CommandLayer implements ScopeLayer {
  readonly commands: NamedEntries<RegisteredCommand>

  /**
   * Create one command layer with diagnostics specific to its ownership scope.
   * @param scope - the scoped owner, or `undefined` for global registrations.
   */
  constructor(scope: ScopeKey | undefined) {
    this.commands = new NamedEntries(name => new Error(scope === undefined
      ? `command "${name}" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's \`agent.ctx\`)`
      : `command "${name}" is already registered in this scope`))
  }

  /** @returns whether this layer owns no command registrations. */
  isEmpty(): boolean {
    return this.commands.isEmpty()
  }
}

declare module 'cordis' {
  interface Context {
    commands: CommandService
  }

  interface Events {
    /**
     * A command was registered or unregistered. This is an unfiltered registry
     * notification because a global or scoped change may affect any UI view.
     * Observer failures are contained and cannot veto the registry mutation.
     * @mode emit
     */
    'commands/change'(): void
  }
}

/**
 * Parse an exact slash command without normalizing its trailing input.
 *
 * @param line - Complete candidate command line.
 * @returns The parsed command, or `undefined` when the line is not a command.
 */
export function parseCommand(line: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  const name = match[1]
  /* v8 ignore next -- the first capture is required whenever the regular expression matches */
  if (name === undefined) return undefined
  return Object.freeze({ name, rawInput: line.slice(match[0].length) })
}

/** Convert arbitrary abort reasons to one stable rejected Error. */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'command aborted')
}

/** Render arbitrary thrown values without trusting their string coercion. */
function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/** Stop awaiting an uncooperative handler once its owning UI request aborts. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error
          ? error
          : new Error(`command handler rejected with a non-Error value: ${renderThrown(error)}`, { cause: error }))
      },
    )
  })
}

/** Reject invalid command metadata before it can reach a UI protocol. */
function normalizeDefinition(definition: CommandDefinition): RegisteredCommand {
  if (!COMMAND_NAME.test(definition.name)) {
    throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`)
  }
  if (typeof definition.description !== 'string') {
    throw new TypeError(`command "${definition.name}" description must be a string`)
  }
  if (definition.description.trim().length === 0) {
    throw new TypeError(`command "${definition.name}" description must not be empty`)
  }
  if (typeof definition.handler !== 'function') {
    throw new TypeError(`command "${definition.name}" handler must be a function`)
  }
  const rawInput: unknown = definition.input
  let input: CommandInputDescriptor | undefined
  if (rawInput !== undefined) {
    if (typeof rawInput !== 'object' || rawInput === null || !('hint' in rawInput)
      || typeof rawInput.hint !== 'string') {
      throw new TypeError(`command "${definition.name}" input hint must be a string`)
    }
    if (rawInput.hint.trim().length === 0) {
      throw new TypeError(`command "${definition.name}" input hint must not be empty`)
    }
    input = Object.freeze({ hint: rawInput.hint })
  }
  const normalized = Object.freeze({
    name: definition.name,
    description: definition.description,
    ...input === undefined ? {} : { input },
    handler: definition.handler,
  })
  const descriptor = Object.freeze({
    name: normalized.name,
    description: normalized.description,
    ...normalized.input === undefined ? {} : { input: normalized.input },
  })
  return { definition: normalized, descriptor }
}

/** Validate and detach an untrusted handler result at the registry boundary. */
function normalizeResult(command: string, value: unknown): CommandResult {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError(`command "${command}" handler must return a CommandResult`)
  }
  const result = value as { kind?: unknown; text?: unknown }
  if (result.kind === 'success') {
    if (result.text !== undefined && typeof result.text !== 'string') {
      throw new TypeError(`command "${command}" success text must be a string when supplied`)
    }
    return Object.freeze(result.text === undefined ? { kind: 'success' } : { kind: 'success', text: result.text })
  }
  if (result.kind === 'error') {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) {
      throw new TypeError(`command "${command}" error text must be a non-empty string`)
    }
    return Object.freeze({ kind: 'error', text: result.text })
  }
  throw new TypeError(`command "${command}" returned unknown result kind "${String(result.kind)}"`)
}

/**
 * Human-command registry. Plain-context definitions are global; definitions
 * registered through a command-injected child of an agent context shadow
 * globals for that agent.
 */
export class CommandService extends Service {
  private readonly layers = new ScopedLayers(
    scope => new CommandLayer(scope),
    () => { this.notifyChange() },
  )

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  /**
   * Register a global or calling-agent-scoped command.
   * @param definition - discovery metadata and direct UI handler.
   * @returns the exact effect disposer that unregisters this definition.
   */
  register(definition: CommandDefinition): () => void {
    const registered = normalizeDefinition(definition)
    return this.layers.effect(
      this.ctx,
      layer => layer.commands.insert(registered.definition.name, registered),
      { label: 'commands.register()' },
    )
  }

  /**
   * List the effective immutable command descriptors for one agent.
   * @param agent - exact receiving agent and scoped-layer key.
   * @returns name-sorted descriptors after scoped shadowing.
   */
  list(agent: Agent): readonly CommandDescriptor[] {
    return Object.freeze([...this.view(agent).values()]
      .map(command => command.descriptor)
      // Names are unique in the effective view, so equality is impossible.
      .sort((left, right) => left.name < right.name ? -1 : 1))
  }

  /**
   * Resolve one effective command definition.
   * @param agent - exact receiving agent and scoped-layer key.
   * @param name - command name without a slash.
   * @returns the scoped shadow or global definition.
   */
  find(agent: Agent, name: string): CommandDefinition | undefined {
    return this.view(agent).get(name)?.definition
  }

  /**
   * Parse and execute a known command without sending it to the model.
   * @param agent - exact receiving agent.
   * @param line - complete slash-command line.
   * @param signal - cancellation signal owned by the UI request.
   * @returns a detached result, or `undefined` when syntax or name does not resolve.
   */
  async execute(
    agent: Agent,
    line: string,
    signal: AbortSignal,
  ): Promise<CommandResult | undefined> {
    const parsed = parseCommand(line)
    if (parsed === undefined) return undefined
    const command = this.view(agent).get(parsed.name)
    if (command === undefined) return undefined
    if (signal.aborted) throw abortError(signal)
    const invocation = Object.freeze({ agent, rawInput: parsed.rawInput, signal })
    const output = command.definition.handler(invocation)
    return normalizeResult(parsed.name, await withAbort(Promise.resolve(output), signal))
  }

  /** Resolve global definitions followed by exact scoped shadows. */
  private view(agent: Agent): Map<string, RegisteredCommand> {
    return this.layers.merge(agent, layer => layer.commands)
  }

  /** Notify every registry observer without making UI refresh load-bearing. */
  private notifyChange(): void {
    // Cordis emit uses Array.map: one synchronous throw starves later listeners,
    // and returned promises are discarded. Registry notifications are
    // non-vetoing, so contain each callback independently.
    for (const callback of this.ctx.events.dispatch('emit', ['commands/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`commands/change listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`commands/change listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

export default CommandService
