/**
 * `settings` namespace dictionaries: shell chrome plus the shell-owned
 * General section (nav label and ownerless Tool Call skeleton). Technical
 * mode copy is shared verbatim across locales per the Figma design.
 * Feature-owned rows ship their copy in their own packages.
 */
const SHARED = {
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
  'toolcall.title': 'Tool Call',
} satisfies Record<SettingsKey, string>
