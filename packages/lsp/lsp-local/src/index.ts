/**
 * Generic stdio language-server provider for `ctx.lsp`. One plugin instance configures one server
 * command and its extension→language-id map; load multiple instances for multiple servers. The
 * provider lazily single-flights one server process per `(provider id, canonical workspace
 * realpath)`, serves transient-open queries through it, and evicts a crashed process so a later
 * query can replace it. It reads sources through Node APIs in the host namespace (not `ctx.fs`) and
 * trusts its configured server — no sandbox confinement.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
 * unregisters from `ctx.lsp` and tears down every live server.
 * @module @deepseek-ai/dsh-lsp-local
 */

import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Context } from 'cordis'
import z from 'schemastery'
import { LspProviderId } from '@deepseek-ai/dsh-lsp'
import type {
  LspProvider,
  LspProviderQuery,
  LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
// Side-effect type import: declaration-merges `ctx.lsp` onto Context.
import type {} from '@deepseek-ai/dsh-lsp'
import { canonicalizeWorkspace, readHostSource } from './host.ts'
import { LspInstance } from './instance.ts'
import type { InstanceSpec } from './instance.ts'

export { canonicalizeWorkspace, readHostSource } from './host.ts'
export { encodeMessage, MessageDecoder } from './framing.ts'
export {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'
export { LspInstance } from './instance.ts'
export { LspConnection } from './connection.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'lsp-local'

/** Services required by this plugin. */
export const inject = ['lsp']

/** Credential-shaped ambient env vars are NOT forwarded to the child by default. */
const SENSITIVE_ENV_PATTERN = /KEY|SECRET|TOKEN/i

const DEFAULT_MAX_MESSAGE_BYTES = 16_000_000
const DEFAULT_MAX_STDERR_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 2_000

/** Plugin configuration: one server command plus its extension mapping and host bounds. */
export interface Config {
  /** Stable provider id, reserved on `ctx.lsp` with the extensions. */
  providerId: string
  /** Executable to spawn (absolute, or resolved on PATH at load). */
  command: string
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  extensionToLanguage: Record<string, string>
  /** Arguments passed to the executable (no shell). Default `[]`. */
  args?: string[]
  /** Extra env vars merged on top of the scrubbed ambient env. Default `{}`. */
  env?: Record<string, string>
  /** Static `initialize` options forwarded to the server. Default `null`. */
  initializationOptions?: unknown
  /** Static answer to every `workspace/configuration` item. Default `null`. */
  configuration?: unknown
  /** Largest single framed message accepted from the server (bytes). Default 16000000. */
  maxMessageBytes?: number
  /** Largest stderr tail retained for diagnostics (bytes). Default 1000000. */
  maxStderrBytes?: number
  /** Largest source file this host will open (bytes). Default 4000000. */
  maxDocumentBytes?: number
  /** Graceful `shutdown`/`exit` budget before escalation (ms). Default 5000. */
  shutdownTimeoutMs?: number
  /** SIGTERM→SIGKILL grace after graceful shutdown fails (ms). Default 2000. */
  killGraceMs?: number
}

/** The resolved config after schemastery fills every default; the provider reads this shape. */
type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  providerId: z.string().required(),
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  extensionToLanguage: z.dict(String).required(),
  initializationOptions: z.any().default(null),
  configuration: z.any().default(null),
  maxMessageBytes: z.number().default(DEFAULT_MAX_MESSAGE_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  maxDocumentBytes: z.number().default(DEFAULT_MAX_DOCUMENT_BYTES),
  shutdownTimeoutMs: z.number().default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  killGraceMs: z.number().default(DEFAULT_KILL_GRACE_MS),
})

/**
 * Register a generic stdio LSP provider. Resolves the executable at load (after credential
 * scrubbing) and fails before registration when it is unavailable; the process itself launches
 * lazily on the first matching query.
 * @param ctx - the plugin context (must inject `lsp`).
 * @param config - the resolved plugin configuration (schemastery has filled every default).
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  // Teardown budgets feed `deadline()`, whose `<= 0` is the internal no-timeout sentinel; a
  // nonpositive value would let a server that ignores shutdown hang disposal forever. Fail at load.
  assertPositiveInteger('shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertPositiveInteger('killGraceMs', resolved.killGraceMs)
  const childEnv = buildChildEnv(resolved.env)
  // Resolve the executable eagerly so a misconfigured command fails at load, not on first query.
  const executable = resolveExecutable(resolved.command, childEnv)

  const provider = new LocalLspProvider(resolved, childEnv, executable)
  ctx.effect(() => {
    const dispose = ctx.lsp.registerProvider(provider)
    return async () => {
      dispose()
      await provider.disposeAll()
    }
  }, 'lsp-local.registerProvider')
}

/** Reject a nonpositive or non-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`lsp-local: ${name} must be a positive integer`)
  }
}

/** A pooled generic provider: one server process per canonical workspace, created on demand. */
class LocalLspProvider implements LspProvider {
  readonly id: LspProviderId
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /** Single-flight map: canonical workspace realpath → the (pending) instance for it. */
  private readonly instances = new Map<string, Promise<LspInstance>>()
  private disposed = false

  constructor(
    private readonly config: ResolvedConfig,
    private readonly childEnv: Record<string, string>,
    private readonly executable: string,
  ) {
    this.id = LspProviderId(config.providerId)
    this.extensionToLanguage = config.extensionToLanguage
  }

  /** Read the disposed flag through a method so a `query()` await cannot narrow it to a literal. */
  private isDisposed(): boolean {
    return this.disposed
  }

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    /* v8 ignore next -- the seam unregisters this provider on dispose, so a query never reaches it disposed; defensive. */
    if (this.isDisposed()) throw new Error('lsp-local provider is disposed')
    const workspace = await canonicalizeWorkspace(request.workspaceRoot)
    // Validate and read the source BEFORE spawning a server: a missing/external/non-regular/oversized
    // source must fail without leaving an idle process pooled (the pre-start rejection contract), and
    // the single-handle read preserves the containment/size checks against a mid-read swap.
    const source = await readHostSource(request.filePath, workspace, this.config.maxDocumentBytes)
    // Re-check disposal after the awaits: disposeAll() may have snapshotted the instance map while we
    // were canonicalizing/reading, so creating a server now would leave it unowned by teardown.
    /* v8 ignore next -- guards a dispose landing during the canonicalize/read await; not a reproducible unit race. */
    if (this.isDisposed()) throw new Error('lsp-local provider is disposed')
    const instance = await this.instanceFor(workspace)
    try {
      return await instance.query(request, source, signal)
    } finally {
      // A crashed/closed process must not be reused: drop its slot so the next query starts fresh,
      // but only if the slot still holds THIS instance (a concurrent replacement must survive).
      if (instance.dead) {
        const slot = this.instances.get(workspace)
        /* v8 ignore next -- the slot-undefined arm needs a concurrent eviction of the same slot; defensive. */
        if (slot !== undefined && (await settledInstance(slot)) === instance) {
          this.instances.delete(workspace)
        }
      }
    }
  }

  /** Single-flight one instance per canonical workspace; a rejected creation clears the slot. */
  private instanceFor(workspace: string): Promise<LspInstance> {
    const existing = this.instances.get(workspace)
    if (existing !== undefined) return existing
    const created = Promise.resolve().then(() => this.createInstance(workspace))
    this.instances.set(workspace, created)
    /* v8 ignore next 3 -- createInstance (the LspInstance constructor) does not throw; spawn failures
       surface asynchronously through the instance, so this creation-rejection cleanup is defensive. */
    created.catch(() => {
      if (this.instances.get(workspace) === created) this.instances.delete(workspace)
    })
    return created
  }

  private createInstance(workspace: string): LspInstance {
    const spec: InstanceSpec = {
      command: this.executable,
      args: this.config.args,
      cwd: workspace,
      env: this.childEnv,
      configuration: this.config.configuration,
      initializationOptions: this.config.initializationOptions,
      maxMessageBytes: this.config.maxMessageBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      killGraceMs: this.config.killGraceMs,
    }
    return new LspInstance(spec)
  }

  /** Dispose every live instance and block further queries. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    const pending = [...this.instances.values()]
    this.instances.clear()
    await Promise.all(pending.map(async (entry) => {
      try {
        const instance = await entry
        await instance.dispose()
      } catch {
        // A never-initialized instance already rejected; nothing to tear down.
      }
    }))
  }
}

/** Resolve a slot promise to its instance for identity comparison, tolerating a pending rejection. */
async function settledInstance(slot: Promise<LspInstance>): Promise<LspInstance | undefined> {
  try {
    return await slot
  } catch {
    /* v8 ignore next -- a slot promise only rejects if createInstance throws, which it never does; defensive. */
    return undefined
  }
}

/** The ambient env minus credential-shaped vars, plus the config's explicit env. */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  const scrubbed = Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !SENSITIVE_ENV_PATTERN.test(key),
  ) as [string, string][]
  return { ...Object.fromEntries(scrubbed), ...extra }
}

/**
 * Resolve the server executable to an absolute path: an absolute command is verified directly; a
 * bare command is looked up on the child's PATH. Fails loudly when nothing is executable.
 */
function resolveExecutable(command: string, childEnv: Record<string, string>): string {
  if (isAbsolute(command)) {
    // Verify an absolute command too, so an unavailable one fails at load, not on the first query.
    if (!isExecutableSync(command)) {
      throw new Error(`lsp-local: command "${command}" is not an executable file`)
    }
    return command
  }
  /* v8 ignore next -- buildChildEnv always sets PATH from the ambient env; the further fallbacks are defensive. */
  const pathValue = childEnv.PATH ?? process.env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    if (isExecutableSync(candidate)) return candidate
  }
  throw new Error(`lsp-local: command "${command}" was not found on PATH`)
}

/** Synchronous executable check used only at load-time resolution. */
function isExecutableSync(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
