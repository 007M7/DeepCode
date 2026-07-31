/**
 * Centrally owned version and bilingual copy for the shipped TUI first-run notice.
 *
 * A material wording change increments {@link TUI_FIRST_RUN_WELCOME_NOTICE_VERSION}
 * so every Harness home presents the revised notice once.
 * @module @deepseek-ai/dsh/tui-first-run-welcome-copy
 */

/** Copy version persisted after the user explicitly continues. */
export const TUI_FIRST_RUN_WELCOME_NOTICE_VERSION = 2

/** Locale-shaped text rendered by the first-run welcome overlay. */
export interface TuiFirstRunWelcomeNoticeCopy {
  /** Overlay heading. */
  readonly title: string
  /** Ordered prose paragraphs. */
  readonly paragraphs: readonly string[]
  /** Enter action label. */
  readonly continueLabel: string
  /** Hint shown when the prose is scrollable. */
  readonly scrollHint: string
  /** Status shown while the acknowledgement reaches disk. */
  readonly saving: string
  /** Retry message shown when the acknowledgement cannot be persisted. */
  readonly saveError: string
}

/**
 * Complete notice copy. The shipped TUI currently presents the supplied
 * Simplified Chinese locale; English remains its reviewed locale counterpart.
 */
export const TUI_FIRST_RUN_WELCOME_NOTICE_COPY = Object.freeze({
  'zh-CN': Object.freeze<TuiFirstRunWelcomeNoticeCopy>({
    title: 'DeepSeek Harness',
    paragraphs: Object.freeze([
      '感谢您愿意拨冗试用 DeepSeek Harness。',
      '目前的版本仍处于内部测试阶段，功能仍待完善，体验难免有些粗糙。',
      '“如切如磋，如琢如磨。” 产品的成长，离不开一次次真实的碰撞与坦诚的反馈。您在真实使用中发现的问题，也可能促使我们重新审视，甚至推翻已有的设计。',
      '我们尤其希望听见那些失败、困惑与不顺手的时刻——如果您有任何反馈与建议，请在企业微信群中留言告诉我们。每一条反馈，都会帮助我们把它打磨得更好。',
    ]),
    continueLabel: '继续',
    scrollHint: '↑/↓ 滚动',
    saving: '正在保存确认…',
    saveError: '无法保存确认，请按 Enter 重试。',
  }),
  en: Object.freeze<TuiFirstRunWelcomeNoticeCopy>({
    title: 'DeepSeek Harness',
    paragraphs: Object.freeze([
      'Thank you for taking the time to try DeepSeek Harness.',
      'This release is still in internal testing. Features remain unfinished, and the experience will inevitably feel somewhat rough.',
      '“As one cuts and files, as one carves and polishes.” A product grows through real encounters and candid feedback. Problems you discover in real use may lead us to re-examine, or even overturn, existing designs.',
      'We especially want to hear about moments of failure, confusion, and friction. If you have any feedback or suggestions, please leave a message in the company WeChat group and let us know. Every piece of feedback helps us refine it.',
    ]),
    continueLabel: 'Continue',
    scrollHint: '↑/↓ Scroll',
    saving: 'Saving acknowledgement…',
    saveError: 'Could not save the acknowledgement. Press Enter to retry.',
  }),
})

/** Locale presented by the shipped first-run notice. */
export const TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE = 'zh-CN' as const
