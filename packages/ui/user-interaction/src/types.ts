/**
 * Wire-safe question/answer shapes, free of cordis/service imports so browser
 * type chains (apiproxy api → client) can consume them without loading this
 * package's Context augmentation.
 * @module @deepseek-ai/dsh-user-interaction/types
 */

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}

/** One question in a user-interaction request. */
export interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
}

/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. Empty when the answer is purely custom text. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The human's answer. */
export interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}
