/**
 * One provider's editor card: the schema-driven form over its profile
 * subtree, the credential-reference control, and the Apply/Cancel pair.
 * Apply without removals merges (`settings.update`, preserving stored keys
 * outside the patch); apply after a field reset replaces the user section so
 * the reset actually lands.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-client-connection/client'
import {
  getPath, nodeAtPath, rehydrateSchema, SchemaForm, setPath, validateDraft,
} from '@deepseek-ai/dsh-client-schema-form'
import type { SchemaFormSecret } from '@deepseek-ai/dsh-client-schema-form'
import { CredentialControl } from './CredentialControl.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ProviderEditor}. */
export interface ProviderEditorProps {
  /** Provider route id (card title). */
  provider: string
  /** The owning namespace view (schema, layers, secrets). */
  namespace: SettingsNamespaceView
  /** Path from the section root to this provider's profile. */
  settingsPath: readonly string[]
  /** Wire faces for writes. */
  api: Pick<IApiClient, 'settings' | 'credentials'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the editor; `changed` reports whether an Apply committed. */
  onClose: (changed: boolean) => void
}

/** Secrets re-rooted at the profile subtree (paths relative to the editor's form). */
function secretsUnder(namespace: SettingsNamespaceView, path: readonly string[]): SchemaFormSecret[] {
  return namespace.secrets.flatMap((secret) => {
    if (secret.path.length < path.length) return []
    if (!path.every((key, index) => secret.path[index] === key)) return []
    return [{ path: secret.path.slice(path.length), set: secret.set }]
  })
}

/** A user-section subtree as a plain draft object (absent → empty). */
function draftAt(namespace: SettingsNamespaceView, path: readonly string[]): Record<string, unknown> {
  const subtree = getPath(namespace.user, path)
  if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree)) return {}
  return structuredClone(subtree) as Record<string, unknown>
}

/** Whether any key present in `before` is absent from `after` (a reset happened). */
function removedAny(before: unknown, after: unknown): boolean {
  if (typeof before !== 'object' || before === null) return false
  /* v8 ignore next -- the form edits containers in place; a container cannot become a primitive */
  if (typeof after !== 'object' || after === null) return true
  for (const [key, value] of Object.entries(before)) {
    if (!(key in (after as Record<string, unknown>))) return true
    if (removedAny(value, (after as Record<string, unknown>)[key])) return true
  }
  return false
}

/**
 * Render one provider's editing card.
 * @param props - the addressed profile plus wire faces and copy.
 * @returns the editor card.
 */
export function ProviderEditor(props: ProviderEditorProps): ReactNode {
  const { namespace, settingsPath, api, t } = props
  const [draft, setDraft] = useState<Record<string, unknown>>(() => draftAt(namespace, settingsPath))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const root = useMemo(() => rehydrateSchema(namespace.schema), [namespace.schema])
  const node = useMemo(() => nodeAtPath(root, settingsPath), [root, settingsPath])
  const subtreeSchema = useMemo(() => node?.toJSON(), [node])
  const fallback = getPath(namespace.value, settingsPath)
  const secrets = useMemo(() => secretsUnder(namespace, settingsPath), [namespace, settingsPath])

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    const ns = namespace.ns
    const original = getPath(namespace.user, settingsPath)
    const needsReplace = removedAny(original, draft)
    // Merge patches stay minimal (just this profile); a replace must carry
    // the complete next user section because it lands wholesale.
    const patch = settingsPath.length === 0 ? draft : setPath({}, [...settingsPath], draft)
    /* v8 ignore next 3 -- a subtree apply implies the join served this namespace's user layer */
    const nextSection = settingsPath.length === 0
      ? draft
      : setPath(structuredClone((namespace.user ?? {}) as Record<string, unknown>), [...settingsPath], draft)
    /* v8 ignore next -- apply is only reachable from the rendered card, which required a resolved node */
    if (node !== undefined) {
      const sectionError = settingsPath.length === 0 ? validateDraft(node, draft) : undefined
      if (sectionError !== undefined) {
        setBusy(false)
        setFailure(sectionError)
        return
      }
    }
    const response = needsReplace
      ? await api.settings.replace({ ns, section: nextSection })
      : await api.settings.update({ ns, patch })
    setBusy(false)
    if (!response.result.ok) {
      setFailure(response.result.error.message)
      return
    }
    props.onClose(true)
  }

  if (node === undefined || subtreeSchema === undefined) {
    // A directory entry addressing a position its schema cannot resolve is a
    // host-side inconsistency; showing it beats a blank card.
    return <p className={styles['error']}>{`${props.provider}: unresolvable settings path`}</p>
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{props.provider}</span>
      </div>
      <SchemaForm
        schema={subtreeSchema}
        draft={draft}
        fallback={fallback}
        secrets={secrets}
        disabled={props.readOnly || busy}
        onChange={setDraft}
        labels={{
          reset: t('reset'),
          add: t('addLabel'),
          remove: t('removeLabel'),
          secretSet: t('secretSet'),
          secretUnset: t('secretUnset'),
          inherited: t('inherited'),
          unsupported: t('unsupported'),
        }}
        renderField={(context) => {
          if (context.role !== 'credential-ref') return undefined
          return <CredentialControl context={context} credentials={api.credentials} t={t} />
        }}
      />
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <div className={styles['editorActions']}>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={busy}
          onClick={() => { props.onClose(false) }}
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={props.readOnly || busy}
          onClick={() => { void apply() }}
        >
          {busy ? t('applying') : t('apply')}
        </button>
      </div>
    </div>
  )
}
