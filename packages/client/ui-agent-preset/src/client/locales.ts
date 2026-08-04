/** Locale bundles for the agent-preset settings row, composer seat, and management section. */

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | 'title' | 'description' | 'loading' | 'error' | 'userTrust' | 'seatHint' | 'lockedHint'
  | 'nav' | 'sectionIntro' | 'builtIn' | 'defaultBadge' | 'setDefault' | 'edit' | 'view'
  | 'duplicate' | 'delete' | 'newPreset' | 'presetName' | 'presetNamePlaceholder' | 'copyOf'
  | 'composition' | 'readOnlyNotice' | 'save' | 'saving' | 'cancel' | 'close' | 'retry'
  | 'idRequired' | 'idInvalid' | 'idTaken'
  | 'deleteTitle' | 'deleteDescription' | 'deleteConfirm' | 'deleting'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  title: 'Agent preset',
  description: 'Applies to sessions you start from now on. Running sessions keep the preset they began with.',
  loading: 'Loading presets…',
  error: 'Could not load agent presets.',
  userTrust: 'Local',
  seatHint: 'Agent preset for this session — switchable until you send the first message',
  lockedHint: 'This session\'s agent preset is fixed once the conversation starts',
  nav: 'Agent presets',
  sectionIntro:
    'A preset is the plugin composition one session\'s agent runs — its tools, prompt, and capabilities. '
    + 'Built-in presets are read-only; duplicate one to make your own.',
  builtIn: 'Built-in',
  defaultBadge: 'Default',
  setDefault: 'Set as default',
  edit: 'Edit',
  view: 'View',
  duplicate: 'Duplicate',
  delete: 'Delete',
  newPreset: 'New preset',
  presetName: 'Preset name',
  presetNamePlaceholder: 'my-agent',
  copyOf: 'Copied from',
  composition: 'Composition (cordis.yml)',
  readOnlyNotice: 'This preset ships with the deployment and cannot be edited. Duplicate it to make your own.',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  close: 'Close',
  retry: 'Retry',
  idRequired: 'Name the preset.',
  idInvalid: 'Use lowercase letters, digits, and hyphens, starting with a letter or digit.',
  idTaken: 'A preset with this name already exists.',
  deleteTitle: 'Delete this preset?',
  deleteDescription:
    'The composition file is deleted. Sessions already running on it keep working; new sessions cannot select it.',
  deleteConfirm: 'Delete',
  deleting: 'Deleting…',
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
  nav: '智能体',
  sectionIntro: 'preset 即一个会话的 agent 所运行的插件组装 —— 它的工具、提示词与能力。内置 preset 只读；复制一份即可改成自己的。',
  builtIn: '内置',
  defaultBadge: '默认',
  setDefault: '设为默认',
  edit: '编辑',
  view: '查看',
  duplicate: '复制',
  delete: '删除',
  newPreset: '新建 preset',
  presetName: 'preset 名称',
  presetNamePlaceholder: 'my-agent',
  copyOf: '复制自',
  composition: '组装（cordis.yml）',
  readOnlyNotice: '该 preset 随部署提供，不可编辑。复制一份即可改成自己的。',
  save: '保存',
  saving: '正在保存…',
  cancel: '取消',
  close: '关闭',
  retry: '重试',
  idRequired: '请填写 preset 名称。',
  idInvalid: '只能使用小写字母、数字与连字符，且以字母或数字开头。',
  idTaken: '同名 preset 已存在。',
  deleteTitle: '删除该 preset？',
  deleteDescription: '组装文件将被删除。已在其上运行的会话不受影响；新会话将无法再选择它。',
  deleteConfirm: '删除',
  deleting: '正在删除…',
}
