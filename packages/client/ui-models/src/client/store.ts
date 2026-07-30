/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm.providers`), the settings namespaces (`settings.describe`),
 * and the referenced credentials (`credentials.describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { getPath, hasPath } from '@deepseek-ai/dsh-client-schema-form'

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialView | undefined
  /** Whether the redacted secret sidecar reports an effective literal `apiKey`. */
  literalApiKeyConfigured: boolean
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(namespace: SettingsNamespaceView | undefined, path: readonly string[]): string | undefined {
  if (namespace === undefined) return undefined
  const profile = getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** Whether one namespace's redacted sidecar reports a set literal API key. */
function literalApiKeyConfigured(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
): boolean {
  if (namespace === undefined) return false
  const secretPath = [...path, 'apiKey']
  return namespace.secrets.some(secret =>
    secret.set
    && secret.path.length === secretPath.length
    && secret.path.every((key, index) => key === secretPath[index]))
}

/** Safe display text for a rejected transport or business response. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (settings/credentials/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>) {}

  /**
   * Refresh the whole page snapshot: directory and namespaces in parallel,
   * then one batched credential describe over every referenced ref. A
   * failure keeps the last good rows and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: SettingsNamespaceView[]
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      providers = providersResponse.result.value.providers
      writable = settingsResponse.result.value.writable
      views = settingsResponse.result.value.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && hasPath(namespace.user, entry.settingsPath)
        && !hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath),
        credential: undefined,
        literalApiKeyConfigured: literalApiKeyConfigured(namespace, entry.settingsPath),
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // Credential state is an enrichment for the Models page, while the
        // onboarding readiness projection below reports its failure.
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = errorText(error)
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map(row => ({
        ...row,
        ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
          ? { credential: credentials[row.apiKeyEnv] }
          : {},
      }))
      s.namespaces = namespaces
    })
  }
}

/** DeepSeek onboarding readiness derived only from the shared Models join. */
export type DeepSeekReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'configured'; source: 'literal' | 'credential'; ref?: string; credential?: CredentialView }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'provider-inactive'
      | 'settings-unavailable'
      | 'credential-ref-unavailable'
      | 'credentials-unavailable'
      | 'credential-read-only'
    message: string
  }

/**
 * Project official-DeepSeek readiness from the provider/settings/credential
 * join used by the Models page. A missing directory entry means the adapter
 * is not mounted and therefore cannot be repaired by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function deepSeekReadiness(state: ModelsSettingsState): DeepSeekReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'settings-unavailable',
      message: state.error ?? 'provider/settings describe failed',
    }
  }
  const row = state.rows.find(candidate => candidate.entry.provider === 'deepseek-official')
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
      message: 'the deepseek-official route is not active',
    }
  }
  if (!row.configured) {
    return {
      kind: 'unavailable',
      reason: 'settings-unavailable',
      message: `settings namespace "${row.entry.settingsNs}" did not resolve the provider profile`,
    }
  }
  if (row.literalApiKeyConfigured) return { kind: 'configured', source: 'literal' }
  if (row.apiKeyEnv === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credential-ref-unavailable',
      message: 'the resolved DeepSeek settings do not name an apiKeyEnv credential reference',
    }
  }
  if (state.credentialError !== null) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
      message: state.credentialError,
    }
  }
  if (row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
      message: `credential reference "${row.apiKeyEnv}" was not described`,
    }
  }
  if (row.credential.configured) {
    return {
      kind: 'configured',
      source: 'credential',
      ref: row.apiKeyEnv,
      credential: row.credential,
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
      message: `credential reference "${row.apiKeyEnv}" is missing and read-only`,
    }
  }
  return { kind: 'credential-missing' }
}
