// EmptyState (figma NEW SESSION screen): centered hero card built around the
// SAME InputBar component the resident composer uses (the empty→content
// transition is one component changing position, never a swap). Project
// picker: cwd set derived in-component from the standard useSessions hook
// (subscription is the framework's, derivation is a pure function — design
// §6) plus a free-form new-directory input; submit runs the startSession
// chain (create → open → send) in one service call.

import { useMemo, useState } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { EmptyStateSlotProps } from '../contract/slots.ts'
import { InputBar } from './InputBar.tsx'
import type { InputBarError } from './InputBar.tsx'
import css from './EmptyState.module.css'

/** Select sentinel for the free-form directory entry (impossible as a real path: not absolute). */
const NEW_DIR = '::new-directory'

/** Full props composed by reference from the contract (runtime share & injected share; no store). */
export type EmptyStateProps = EmptyStateSlotProps

/** Deduped cwd set in list order (pure derivation over the sessions list). */
function deriveCwds(state: SessionListState): readonly string[] {
  const seen = new Set<string>()
  for (const id of state.ids) {
    const cwd = state.byId[id]?.cwd
    if (cwd !== undefined && cwd !== '') seen.add(cwd)
  }
  return [...seen]
}

export function EmptyState({ useSessions, startSession }: EmptyStateProps) {
  const list = useSessions(s => s)
  const cwds = useMemo(() => deriveCwds(list), [list])
  // Local viewing state: the empty state owns no session, so its draft is
  // ephemeral by design (drafts are keyed by session id; there is none yet).
  const [draft, setDraft] = useState('')
  const [cwd, setCwd] = useState<string>('')
  const [custom, setCustom] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<InputBarError | null>(null)

  const submit = (mode: 'queue' | 'steer'): void => {
    const text = draft.trim()
    /* v8 ignore next -- defensive: InputBar disables send while empty. */
    if (text === '' || sending) return
    setSending(true)
    setError(null)
    const chosen = cwd.trim()
    startSession({ text, mode, ...(chosen === '' ? {} : { cwd: chosen }) })
      .catch((reason: unknown) => {
        // The empty state survives failure with the draft intact (no session
        // exists to carry promptError; this is the only local error surface).
        setError({ op: 'send', message: reason instanceof Error ? reason.message : String(reason) })
        setSending(false)
      })
    // Success needs no cleanup: the session selection swaps this slot out for the session body.
  }

  const picker = (
    <div className={css.picker}>
      {custom
        ? (
            <input
              className={css.customInput}
              value={cwd}
              autoFocus
              placeholder="目录路径，如 /home/me/proj"
              onChange={(e) => { setCwd(e.target.value) }}
            />
          )
        : (
            <select
              className={css.select}
              value={cwd}
              aria-label="项目目录"
              onChange={(e) => {
                if (e.target.value === NEW_DIR) {
                  setCustom(true)
                  setCwd('')
                } else {
                  setCwd(e.target.value)
                }
              }}
            >
              <option value="">默认目录</option>
              {cwds.map(c => <option key={c} value={c}>{c}</option>)}
              <option value={NEW_DIR}>新目录…</option>
            </select>
          )}
    </div>
  )

  return (
    <div className={css.root}>
      <div className={css.card}>
        <div className={css.headline}>
          {/* figma 34:10412: fish 34x25 leading the headline, gap 10. */}
          <FishLogo size={34} className={css.fish} />
          Let&apos;s start building
        </div>
        <InputBar
          draft={draft}
          running={false}
          disabled={sending}
          error={error}
          variant="hero"
          placeholder="Message to run task, plan and build"
          accessory={picker}
          onDraftChange={setDraft}
          onSend={submit}
          /* v8 ignore next -- structural noop: hero never passes running=true, so stop is unreachable. */
          onStop={() => {}}
        />
      </div>
    </div>
  )
}
