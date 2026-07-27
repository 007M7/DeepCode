/** Inert no-session input body; the resident Hero shell renders around it. */

import clsx from 'clsx'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './InputBar.module.css'

/** Disabled visual twin of the session-bound InputBar. */
export function DisabledInputBar() {
  return (
    <div className={clsx(css.root, css.hero)}>
      <div className={css.card}>
        <div className={css.grow}>
          <textarea
            className={css.input}
            value=""
            disabled
            placeholder="Choose a workspace to start"
            rows={2}
            readOnly
          />
          <div aria-hidden className={css.mirror}>{'\n'}</div>
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            <button type="button" className={css.add} aria-label="Add attachment" disabled>
              <IconPlusOutline16 size={14} />
            </button>
          </div>
          <div className={css.trailing}>
            <button type="button" className={css.primary} aria-label="Send message" disabled>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M8 13V3.8M8 3.8L3.8 8M8 3.8L12.2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
