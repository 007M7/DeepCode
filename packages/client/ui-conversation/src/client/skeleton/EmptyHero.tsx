// Hero chrome for the blank-draft phase of ConversationRoot: fish headline,
// glow backdrop, and the workspace row. Pure presentation — the resident
// composer is NOT rendered here (it keeps its own stable tree position in
// ConversationRoot so the textarea survives the hero → composer flip); CSS
// positions it over this shell's glow area during the hero phase.

import { useId } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  FishLogo, IconChevronDownOutline14, IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import css from './HeroShell.module.css'

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
 * The workspace chip (folder + label + chevron), always interactive: before
 * the first message the workspace stays switchable — picking another one
 * moves the New Session flow to that workspace's blank session.
 * @param props.label - chip label (see {@link workspaceLabel}).
 * @param props.menuOpen - menu expansion echo.
 * @param props.onClick - menu toggle.
 * @returns the chip button element.
 */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label: string
  menuOpen?: boolean
  onClick?: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.workspace}
      aria-label="Choose workspace"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={onClick}
    >
      <IconFolderOpen16 className={css.folder} size={16} />
      <span className={css.workspaceLabel}>{label}</span>
      <IconChevronDownOutline14 className={css.chevron} size={12} />
    </button>
  )
}

/** Hero chrome props. The workspace row rides the InputBar accessory hole, not here. */
export interface HeroShellProps {
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/**
 * Render the hero chrome (headline + glow; no composer, no workspace row).
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
export function HeroShell({ children }: HeroShellProps) {
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
          {/* figma 313:14109: soft ellipse behind workspace + composer; width
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
          {/* The resident composer (rendered by ConversationRoot at its stable
              tree position; the workspace row rides its accessory hole) is
              CSS-positioned into this gap during the hero phase — see
              ConversationRoot.module.css [data-phase='hero']. */}
        </div>
      </div>
      {children}
    </div>
  )
}
