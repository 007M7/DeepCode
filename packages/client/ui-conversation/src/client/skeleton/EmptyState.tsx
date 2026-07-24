// EmptyState (figma NEW SESSION screen): centered hero — fish + title,
// workspace picker row, then the SAME InputBar the resident composer uses
// (empty→content is a position move, never a swap). Project picker: cwd set
// derived in-component from useSessions plus a free-form new-directory path;
// submit runs startSession (create → open → send).

import { useId, useMemo, useState } from 'react'
import {
  FishLogo,
  IconChevronDownOutline14,
  IconFolderOpen16,
  Menu,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { EmptyStateSlotProps } from '../contract/slots.ts'
import { InputBar } from './InputBar.tsx'
import type { InputBarError } from './InputBar.tsx'
import css from './EmptyState.module.css'

/** Menu id for the free-form directory entry (not a filesystem path). */
const NEW_DIR = '::new-directory'
/** Menu id for the host default project directory (empty cwd on create). */
const DEFAULT_DIR = '::default'

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

/** Basename for the workspace chip; empty → the design's "New Workspace" label. */
function workspaceLabel(cwd: string): string {
  if (cwd === '') return 'New Workspace'
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base !== undefined && base !== '' ? base : cwd
}

export function EmptyState({ useSessions, startSession }: EmptyStateProps) {
  const list = useSessions(s => s)
  const cwds = useMemo(() => deriveCwds(list), [list])
  // Local viewing state: the empty state owns no session, so its draft is
  // ephemeral by design (drafts are keyed by session id; there is none yet).
  const [draft, setDraft] = useState('')
  const [cwd, setCwd] = useState('')
  const [custom, setCustom] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<InputBarError | null>(null)
  // Stable filter id so multiple EmptyState mounts do not collide in the DOM.
  const glowFilterId = `empty-glow-${useId().replace(/:/g, '')}`

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

  const items: MenuItem[] = [
    { id: DEFAULT_DIR, label: 'Default directory' },
    ...cwds.map(c => ({ id: c, label: c })),
    { id: NEW_DIR, label: 'New directory…' },
  ]
  const selectedId = custom ? NEW_DIR : cwd === '' ? DEFAULT_DIR : cwd

  const workspace = custom
    ? (
        <input
          className={css.customInput}
          value={cwd}
          autoFocus
          aria-label="项目目录"
          placeholder="Directory path, e.g. /home/me/proj"
          onChange={(e) => { setCwd(e.target.value) }}
        />
      )
    : (
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          selectedId={selectedId}
          items={items}
          onSelect={(id) => {
            if (id === NEW_DIR) {
              setCustom(true)
              setCwd('')
            } else if (id === DEFAULT_DIR) {
              setCustom(false)
              setCwd('')
            } else {
              setCustom(false)
              setCwd(id)
            }
            setMenuOpen(false)
          }}
          anchor={(
            <button
              type="button"
              className={css.workspace}
              aria-label="项目目录"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(!menuOpen) }}
            >
              <IconFolderOpen16 className={css.folder} size={16} />
              <span className={css.workspaceLabel}>{workspaceLabel(cwd)}</span>
              <IconChevronDownOutline14 className={css.chevron} size={14} />
            </button>
          )}
        />
      )

  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          {/* figma 34:10412: fish 34×25 leading the headline, gap 10. */}
          <FishLogo size={34} className={css.fish} />
          Let&apos;s start building
        </div>
        <div className={css.body}>
          {/* figma 313:14109: soft ellipse behind workspace + InputBar; width
              tracks the card (1051/776) so blur scales in userSpace with it. */}
          <svg className={css.glow} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
            <defs>
              <filter
                id={glowFilterId}
                x="0"
                y="0"
                width="1051"
                height="468"
                filterUnits="userSpaceOnUse"
                colorInterpolationFilters="sRGB"
              >
                <feFlood floodOpacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
              </filter>
            </defs>
            <g filter={`url(#${glowFilterId})`}>
              <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.1" />
            </g>
          </svg>
          <div className={css.workspaceRow}>{workspace}</div>
          <InputBar
            draft={draft}
            running={false}
            disabled={sending}
            error={error}
            variant="hero"
            placeholder="Message to run task, plan and build, enter for / commands"
            onDraftChange={setDraft}
            onSend={submit}
            /* v8 ignore next -- structural noop: hero never passes running=true, so stop is unreachable. */
            onStop={() => {}}
          />
        </div>
      </div>
    </div>
  )
}
