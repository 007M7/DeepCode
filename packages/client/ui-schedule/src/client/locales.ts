/** `schedule` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'schedule'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'reminder.title': '定时提醒',
  'reminder.delivery': '仅在当前会话中交付',
  'reminder.invalid': '提醒回执不可用',
  'reminder.id': '编号 {id}',
  'reminder.occurrence': '触发时间 {time}',
} satisfies Record<string, string>

/** The Schedule namespace key union. */
export type ScheduleKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'reminder.title': 'Scheduled reminder',
  'reminder.delivery': 'Delivered in this session only',
  'reminder.invalid': 'Reminder receipt unavailable',
  'reminder.id': 'ID {id}',
  'reminder.occurrence': 'Due at {time}',
} satisfies Record<ScheduleKey, string>
