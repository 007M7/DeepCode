/**
 * Bilingual copy of the question composer, registered under the `question`
 * namespace. Question/option text itself arrives from the model verbatim —
 * these dictionaries cover only the chrome around it.
 */
import type { LocaleDict } from '@deepseek-ai/dsh-client-locale/client'

/** Namespace owning the question-composer copy. */
export const QUESTION_NS = 'question'

/** Simplified Chinese dictionary (the fallback locale). */
export const zh: LocaleDict = {
  'dismiss': '放弃整组问题',
  'pager.prev': '上一题',
  'pager.next': '下一题',
  'option.recommended': '推荐',
  'custom.placeholder': '输入你的答案',
  'error.incomplete': '请先完成这道问题。',
  'error.empty': '请选择一个选项或填写自定义答案。',
  'action.skip': '跳过本题',
  'action.next': '下一题',
  'action.submit': '提交',
  'action.submitting': '正在提交…',
}

/** English dictionary. */
export const en: LocaleDict = {
  'dismiss': 'Dismiss all questions',
  'pager.prev': 'Previous question',
  'pager.next': 'Next question',
  'option.recommended': 'Recommended',
  'custom.placeholder': 'Type your answer',
  'error.incomplete': 'Please finish this question first.',
  'error.empty': 'Choose an option or type a custom answer.',
  'action.skip': 'Skip this question',
  'action.next': 'Next',
  'action.submit': 'Submit',
  'action.submitting': 'Submitting…',
}
