/**
 * `settings.general` namespace dictionaries. Skeleton-row technical copy
 * (Read only / Schema mode / Code mode and their descriptions) is shared
 * verbatim across locales per the Figma design.
 */
import type { LocaleDict } from '@deepseek-ai/dsh-client-locale/client'

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
  'nav': '通用设置',
  'permission.title': '权限',
  'permission.desc': '选择默认权限模式',
  'toolcall.title': '工具调用',
  'language.title': '语言',
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
}

/** English dictionary. */
export const en: LocaleDict = {
  ...SHARED,
  'nav': 'General',
  'permission.title': 'Permission',
  'permission.desc': 'Choose default permission mode',
  'toolcall.title': 'Tool Call',
  'language.title': 'Language',
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
}
