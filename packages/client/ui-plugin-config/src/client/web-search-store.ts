/**
 * The web-search card's state and writes over the `web-search-deepseek`
 * settings namespace.
 *
 * The key is the one field that does not live in the section: its literal
 * never rides a response, so the card learns only whether one is configured
 * and writes it through the credentials domain, addressed by the reference
 * the section names.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardController, fieldOf, shellOf, type CardField, type CardShell } from './card-store.ts'

/**
 * Namespace of the DeepSeek search provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const WEB_SEARCH_NS = 'web-search-deepseek'

/** Credential reference the provider resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** The search-provider fields this card edits. */
export interface WebSearchSettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Provider endpoint; blank inherits the provider default. */
  baseURL?: string
  /** Maximum searches served within one request. */
  maxUses?: number
}

/** What the web-search card renders. */
export interface WebSearchCardState extends CardShell {
  /** Provider endpoint. */
  baseURL: CardField<string>
  /** Searches allowed per request. */
  maxUses: CardField<number | undefined>
  /** Credential reference the key is written under. */
  apiKeyRef: string
  /** Whether the Host reports a credential configured for that reference. */
  apiKeyConfigured: boolean
}

/** The registration-side face the web-search card's slot entry injects. */
export interface WebSearchCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
  /** Write the provider endpoint; the empty string clears it. */
  setBaseUrl: (next: string) => void
  /** Clear the endpoint so it re-inherits the composition layer. */
  resetBaseUrl: () => void
  /** Write the per-request search budget. */
  setMaxUses: (next: number) => void
  /** Clear the budget so it re-inherits the composition layer. */
  resetMaxUses: () => void
  /** Write the credential the section references. */
  setApiKey: (next: string) => void
}

/** Bridges the `web-search-deepseek` scope and the credentials domain onto the card. */
export class WebSearchCardController extends CardController<WebSearchSettings, WebSearchCardState> {
  private readonly credential: { configured: boolean }

  /**
   * @param scope - the bound settings scope for the `web-search-deepseek` namespace.
   * @param api - wire face used for the credential the section references.
   */
  constructor(scope: SettingsScope<WebSearchSettings>, private readonly api: Pick<IApiClient, 'credentials'>) {
    // Held in its own object because the projection runs during `super()`,
    // before `this` exists, and must still see the latest credential state:
    // that state comes from its own domain, so a settings change must not
    // silently reset it to unknown.
    const credential = { configured: false }
    super(scope, snapshot => ({
      ...shellOf(snapshot),
      baseURL: fieldOf(snapshot, 'baseURL', ''),
      maxUses: fieldOf(snapshot, 'maxUses', undefined),
      apiKeyRef: refOf(snapshot),
      apiKeyConfigured: credential.configured,
    }))
    this.credential = credential
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  /** Ask the credentials domain whether the referenced key exists. */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch (_credentialReadFailure) {
      // The card stays usable without this: the key control simply reports the
      // last state it knew, and a write still reaches the Host.
      return
    }
    if (!response.result.ok) return
    const next = response.result.value.credentials[ref]?.configured ?? false
    if (next === this.credential.configured) return
    this.credential.configured = next
    this.store.set({ ...this.store.getSnapshot(), apiKeyConfigured: next })
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its write actions.
   */
  inject(): WebSearchCardFace {
    return {
      hooks: { webSearchCard: this.store },
      setBaseUrl: (next: string) => { void this.scope.set('baseURL', next) },
      resetBaseUrl: () => { void this.scope.unset('baseURL') },
      setMaxUses: (next: number) => { void this.scope.set('maxUses', next) },
      resetMaxUses: () => { void this.scope.unset('maxUses') },
      setApiKey: (next: string) => { void this.writeKey(next) },
    }
  }

  private async writeKey(value: string): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    try {
      await this.api.credentials.set({ ref, value })
    } catch (_credentialWriteFailure) {
      // Refusals surface through the re-read below: the Host is the only
      // authority on whether the key now exists.
    }
    await this.readCredential()
  }
}

/**
 * The credential reference the section names, or the provider's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: SettingsScopeSnapshot<WebSearchSettings>): string {
  const section = snapshot.value
  const declared = section?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}
