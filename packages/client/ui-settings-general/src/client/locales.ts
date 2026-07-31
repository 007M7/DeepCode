/**
 * `settings` namespace dictionaries: shell chrome plus the shell-owned
 * General section (nav label, skeleton rows). Skeleton-row technical copy
 * (Read only / Schema mode / Code mode and their descriptions) is shared
 * verbatim across locales per the Figma design. Feature-owned rows
 * (Language, Appearance) ship their copy in their own packages.
 */
const SHARED = {
  'permission.value': 'Read only',
  'toolcall.schema.title': 'Schema mode',
  'toolcall.schema.desc': 'Traditional function calling — invoke tools one at a time',
  'toolcall.code.title': 'Code mode',
  'toolcall.code.desc': 'Chain multiple tools with code — multi-step orchestration',
} satisfies Record<string, string>

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  ...SHARED,
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'general.nav': '通用设置',
  'permission.title': '权限',
  'permission.desc': '选择默认权限模式',
  'toolcall.title': '工具调用',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  ...SHARED,
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'general.nav': 'General',
  'permission.title': 'Permission',
  'permission.desc': 'Choose default permission mode',
  'toolcall.title': 'Tool Call',
} satisfies Record<SettingsKey, string>
