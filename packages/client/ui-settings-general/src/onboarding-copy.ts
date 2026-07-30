/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-07-30.2'

/** The complete editable welcome notice in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: '内测声明',
    lead: '感谢您试用 DeepSeek Harness。目前仍处于内部测试阶段，部分功能与体验还在持续打磨。',
    feedbackTitle: '我们最想听见：失败、困惑和不顺手',
    feedbackBody: '如果它没帮到您，甚至给工作添了麻烦，请在企业微信群告诉我们。',
    closing: '真实使用中的每一个问题，都可能促使我们重新审视，甚至推翻已有设计。',
    quote: '“如切如磋，如琢如磨。”',
    continueLabel: '继续',
  },
  en: {
    title: 'Internal Testing Notice',
    lead: 'Thank you for trying DeepSeek Harness. This version is still in internal testing, and some features and experiences remain under refinement.',
    feedbackTitle: 'What we most want to hear: failures, confusion, and friction',
    feedbackBody: 'If it did not help—or even made your work harder—please tell us in the company WeChat group.',
    closing: 'Every problem found in real use may prompt us to reconsider, or even overturn, an existing design.',
    quote: '“As one cuts and files, as one chisels and polishes.”',
    continueLabel: 'Continue',
  },
} as const
