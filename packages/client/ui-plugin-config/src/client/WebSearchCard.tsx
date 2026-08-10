/**
 * The web-search provider's card: its endpoint, its per-request search budget,
 * and the key — which is written through the credentials domain, never into
 * the settings section, so the literal never rides a response.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NumberField, SecretField, TextField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { WebSearchCardState } from './web-search-store.ts'
import type {} from './slot-contract.ts'

/** Registration-side business face for the web-search card. */
export interface WebSearchCardInjected {
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

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.pluginConfig'>
  & InjectFace<WebSearchCardInjected>

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its write actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      available={state.available}
      readOnly={disabled}
    >
      <SecretField
        id="plugin-config-web-search-key"
        label={t('webSearchApiKey')}
        hint={t('webSearchApiKeyHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        // The credentials domain accepts a key even when the settings document
        // itself is read-only; they are separate stores with separate refusals.
        disabled={false}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('webSearchApiKeySet') : t('webSearchApiKeyUnset')}
        onCommit={props.setApiKey}
      />
      <TextField
        id="plugin-config-web-search-endpoint"
        label={t('webSearchBaseUrl')}
        hint={t('webSearchBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        overridden={state.baseURL.overridden}
        disabled={disabled}
        value={state.baseURL.value}
        onCommit={props.setBaseUrl}
        onReset={props.resetBaseUrl}
      />
      <NumberField
        id="plugin-config-web-search-max-uses"
        label={t('webSearchMaxUses')}
        hint={t('webSearchMaxUsesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        overridden={state.maxUses.overridden}
        disabled={disabled}
        value={state.maxUses.value}
        onCommit={props.setMaxUses}
        onReset={props.resetMaxUses}
      />
    </PluginCard>
  )
}
