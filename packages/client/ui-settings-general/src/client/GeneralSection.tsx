/**
 * The General section (figma 501:29983 'Options'): Permission and Tool Call
 * skeleton rows, then the feature-contributed preference rows from the
 * `settings.general.item` slot (locale → Language, ui-theme → Appearance).
 * The section column stacks rows; each row draws its own internals and
 * separator.
 */
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GeneralSection.module.css'

/** Injected face of the General section: the settings-namespace translate. */
export interface GeneralSectionInjected {
  /** Translate a `settings` dictionary key to the active-locale text. */
  t: (key: string) => string
}

/** Full component props: section owner share + item render share + inject face. */
export type GeneralSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.general.item'> & GeneralSectionInjected

/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSection({ t, renderSlot }: GeneralSectionComponentProps) {
  return (
    <div className={css.section}>
      {/* Permission (skeleton): disabled selector pill. */}
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('permission.title')}</div>
          <div className={css.desc}>{t('permission.desc')}</div>
        </div>
        <button type="button" className={css.selector} disabled>
          {t('permission.value')}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      </div>

      {/* Tool Call (skeleton): schema cube pinned selected, code cube unselected. */}
      <div className={css.group}>
        <div className={css.title}>{t('toolcall.title')}</div>
        <div className={css.cubeRow}>
          <div className={`${css.modeCube} ${css.selected}`}>
            <div className={css.title}>{t('toolcall.schema.title')}</div>
            <div className={css.desc}>{t('toolcall.schema.desc')}</div>
          </div>
          <div className={css.modeCube}>
            <div className={css.title}>{t('toolcall.code.title')}</div>
            <div className={css.desc}>{t('toolcall.code.desc')}</div>
          </div>
        </div>
      </div>

      {/* Feature-owned preference rows (Language, Appearance, …). */}
      {renderSlot('settings.general.item', {})}
    </div>
  )
}
