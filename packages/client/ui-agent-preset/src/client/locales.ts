/** Locale bundles for the agent-preset General-settings row. */

/** Locale keys this row renders. */
export type AgentPresetSettingsKey =
  | 'title' | 'description' | 'loading' | 'error' | 'userTrust' | 'seatHint' | 'lockedHint'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  title: 'Agent preset',
  description: 'Applies to sessions you start from now on. Running sessions keep the preset they began with.',
  loading: 'Loading presets…',
  error: 'Could not load agent presets.',
  userTrust: 'Local',
  seatHint: 'Agent preset for this session — switchable until you send the first message',
  lockedHint: 'This session\'s agent preset is fixed once the conversation starts',
}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  title: 'Agent preset',
  description: '对此后新建的会话生效。运行中的会话保持它开始时的 preset。',
  loading: '正在加载 preset…',
  error: '无法加载 agent preset。',
  userTrust: '本地',
  seatHint: '本会话的 agent preset —— 发送第一条消息前可切换',
  lockedHint: '会话开始后，其 agent preset 即固定',
}
