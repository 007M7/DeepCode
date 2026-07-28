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
                <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
