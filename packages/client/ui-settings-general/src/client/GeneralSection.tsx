/**
 * The General section (figma 501:29983 'Options'): one column rendering the
 * `settings.general.item` contributions. Features own their rows; this
 * package contributes only the ownerless Tool Call skeleton.
 */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GeneralSection.module.css'

/** Full component props: section owner share plus item render share. */
export type GeneralSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.general.item'>

/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSection({ renderSlot }: GeneralSectionComponentProps) {
  return (
    <div className={css.section}>
      {renderSlot('settings.general.item', {})}
    </div>
  )
}

/** Props of the ownerless Tool Call item contribution. */
export type ToolCallSkeletonProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>

/**
 * Render the static Tool Call mode choice until its host setting exists.
 * @param props - item runtime and translated copy.
 * @returns the skeleton row.
 */
export function ToolCallSkeleton({ t }: ToolCallSkeletonProps) {
  return (
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
  )
}
