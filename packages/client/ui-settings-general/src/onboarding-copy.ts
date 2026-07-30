/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-07-30.1'

/** The complete editable welcome notice in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    paragraphs: [
      '感谢您愿意拨冗试用 DeepSeek Harness。',
      '目前的版本仍处于内部测试阶段，有些功能仍待完善，有些体验难免粗粝。',
      '“如切如磋，如琢如磨。” 产品的成长，离不开一次次真实的碰撞与坦诚的反馈。您在真实使用中暴露的问题，也可能促使我们重新审视，甚至推翻已有的设计。',
      '我们尤其希望听见那些失败、困惑与不顺手的时刻——如果它未能帮到您，甚至反而为工作平添了麻烦，请在企业微信群中留言，将使用感受告诉我们。每一条反馈，都会帮助我们把它打磨得更好。',
    ],
    continueLabel: '继续',
  },
  en: {
    paragraphs: [
      'Thank you for taking the time to try DeepSeek Harness.',
      'This version is still in internal testing. Some features remain unfinished, and parts of the experience may feel rough.',
      '“As one cuts and files, as one chisels and polishes.” A product grows through real encounters and candid feedback. Problems you uncover in real use may prompt us to reconsider—or even overturn—our existing designs.',
      'We especially want to hear about failures, confusion, and friction. If it did not help you, or even made your work harder, please leave a message in the company WeChat group and tell us about your experience. Every piece of feedback helps us refine it.',
    ],
    continueLabel: 'Continue',
  },
} as const
