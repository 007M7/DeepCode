/**
 * `settings` namespace dictionaries: shell chrome plus the shell-owned
 * General section (nav label, skeleton rows). Skeleton-row technical copy
 * (Read only / Schema mode / Code mode and their descriptions) is shared
 * verbatim across locales per the Figma design. Feature-owned rows
 * (Language, Appearance) ship their copy in their own packages.
 */
import type { LocaleDict } from '@deepseek-ai/dsh-client-locale/client'
import { WELCOME_NOTICE_COPY } from '../onboarding-copy.ts'

const SHARED = {
  'permission.value': 'Read only',
  'toolcall.schema.title': 'Schema mode',
  'toolcall.schema.desc': 'Traditional function calling — invoke tools one at a time',
  'toolcall.code.title': 'Code mode',
  'toolcall.code.desc': 'Chain multiple tools with code — multi-step orchestration',
} satisfies LocaleDict

/** Simplified Chinese dictionary. */
export const zh: LocaleDict = {
  ...SHARED,
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'general.nav': '通用设置',
  'permission.title': '权限',
  'permission.desc': '选择默认权限模式',
  'toolcall.title': '工具调用',
  'welcome.paragraph.0': WELCOME_NOTICE_COPY.zh.paragraphs[0],
  'welcome.paragraph.1': WELCOME_NOTICE_COPY.zh.paragraphs[1],
  'welcome.paragraph.2': WELCOME_NOTICE_COPY.zh.paragraphs[2],
  'welcome.paragraph.3': WELCOME_NOTICE_COPY.zh.paragraphs[3],
  'welcome.continue': WELCOME_NOTICE_COPY.zh.continueLabel,
  'welcome.error': '暂时无法保存确认状态，请重试。',
}

/** English dictionary. */
export const en: LocaleDict = {
  ...SHARED,
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'general.nav': 'General',
  'permission.title': 'Permission',
  'permission.desc': 'Choose default permission mode',
  'toolcall.title': 'Tool Call',
  'welcome.paragraph.0': WELCOME_NOTICE_COPY.en.paragraphs[0],
  'welcome.paragraph.1': WELCOME_NOTICE_COPY.en.paragraphs[1],
  'welcome.paragraph.2': WELCOME_NOTICE_COPY.en.paragraphs[2],
  'welcome.paragraph.3': WELCOME_NOTICE_COPY.en.paragraphs[3],
  'welcome.continue': WELCOME_NOTICE_COPY.en.continueLabel,
  'welcome.error': 'The acknowledgement could not be saved. Please try again.',
}
