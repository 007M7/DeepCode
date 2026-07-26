// EmptyHero: the shared NEW SESSION hero (fish headline + glow + workspace
// row + hero InputBar), extracted from EmptyState so the bound guidance
// state (a current session with zero messages, ConversationRoot) renders the
// same layout without the picker wiring. Hosts own the workspace-row content
// and the send wiring; modals ride `children` after the stack.

import { useId } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  FishLogo, IconChevronDownOutline14, IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import { InputBar } from './InputBar.tsx'
import type { InputBarError } from './InputBar.tsx'
import css from './EmptyState.module.css'

/**
 * Basename label for the workspace chip / menu rows (the shared derivation);
 * empty → the design's "New Workspace" placeholder copy; separator-only
 * paths echo the raw cwd.
 * @param cwd - workspace directory path ('' for none).
 * @returns chip label.
 */
export function workspaceLabel(cwd: string): string {
  if (cwd === '') return 'New Workspace'
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * The workspace chip (folder + label + chevron). Locked form (bound guidance
 * state): no chevron, no menu affordance, clicks disabled — the bound
 * session's cwd is final.
 * @param props.label - chip label (see {@link workspaceLabel}).
 * @param props.locked - read-only echo form.
 * @param props.menuOpen - menu expansion echo (interactive form only).
 * @param props.onClick - menu toggle (interactive form only).
 * @returns the chip button element.
 */
export function WorkspaceChip({ buttonRef, label, locked = false, menuOpen = false, onClick }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label: string
  locked?: boolean
  menuOpen?: boolean
  onClick?: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label={locked ? 'Current workspace' : 'Choose workspace'}
      {...(locked ? {} : { 'aria-haspopup': 'menu' as const, 'aria-expanded': menuOpen })}
      disabled={locked}
      onClick={onClick}
    >
      <IconFolderOpen16 className={css.folder} size={16} />
      <span className={css.workspaceLabel}>{label}</span>
      {!locked && <IconChevronDownOutline14 className={css.chevron} size={12} />}
    </button>
  )
}

/** Hero-card props: both hosts supply the workspace row and their send wiring. */
export interface EmptyHeroProps {
  /** Workspace-row content (Menu-wrapped chip in EmptyState; bare locked chip in guidance). */
  workspaceRow: ReactNode
  draft: string
  disabled: boolean
  /** Composer placeholder override (EmptyState's pick-a-workspace hint); defaults to the hero copy. */
  placeholder?: string
  error: InputBarError | null
  status?: string
  onDraftChange: (text: string) => void
  onSend: (mode: 'queue' | 'steer') => void
  /** Overlay content after the stack (EmptyState's modals). */
  children?: ReactNode
}

/**
 * Render the hero card.
 * @param props - see {@link EmptyHeroProps}.
 * @returns the centered hero element tree.
 */
export function EmptyHero({
  workspaceRow,
  draft,
  disabled,
  placeholder,
  error,
  status,
  onDraftChange,
  onSend,
  children,
}: EmptyHeroProps) {
  // Stable filter id so multiple hero mounts do not collide in the DOM.
  const glowFilterId = `empty-glow-${useId().replace(/:/g, '')}`
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
              tracks the card (glow asset 1051 vs design card 776) so blur
              scales in userSpace with it. */}
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
          <div className={css.workspaceRow}>{workspaceRow}</div>
          <InputBar
            draft={draft}
            running={false}
            disabled={disabled}
            error={error}
            {...(status === undefined ? {} : { status })}
            variant="hero"
            placeholder={placeholder ?? 'Describe what you want to build'}
            onDraftChange={onDraftChange}
            onSend={onSend}
            /* v8 ignore next -- structural noop: hero never passes running=true, so stop is unreachable. */
            onStop={() => {}}
          />
        </div>
      </div>
      {children}
    </div>
  )
}
