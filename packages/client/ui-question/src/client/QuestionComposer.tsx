import { useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import type { QuestionResponsePayload } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingInteraction } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button, IconCheckOutline16, IconChevronLeftOutline14, IconChevronRightOutline14,
  IconCloseOutline16, IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionComposerOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './QuestionComposer.module.css'

type QuestionInteraction = Extract<PendingInteraction, { kind: 'question' }>
type Answer = QuestionResponsePayload['answer']

interface DraftAnswer {
  selected: string[]
  custom: string
  customOpen: boolean
  skipped: boolean
}

/** Actions assembled from the session object layer. */
export interface QuestionComposerInjected {
  actions: {
    answer(interaction: QuestionInteraction, answer: Answer): Promise<void>
    cancel(interaction: QuestionInteraction): Promise<void>
  }
}

/** Full question-composer props. */
export type QuestionComposerProps = QuestionComposerOwnerProps & QuestionComposerInjected

/**
 * Split the conventional recommendation suffix without changing the answer value.
 * @param label - Original option label returned if selected.
 * @returns Display label plus recommendation state.
 */
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/**
 * Remove a conventional multi-select suffix so the hint can be styled separately.
 * @param title - Question title supplied by the interaction request.
 * @returns Question title without a trailing multi-select marker.
 */
export function parseQuestionTitle(title: string): string {
  return title.replace(/\s*[（(]可多选[）)]\s*$/, '')
}

/** Return whether a textarea key event belongs to an active IME composition. */
function isComposing(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}

/**
 * Composer takeover boundary; rpcId keys local drafts while same-id replay preserves them.
 * @param props - Pending interaction and scoped answer/cancel actions.
 * @returns The question flow for this request.
 */
export function QuestionComposer(props: QuestionComposerProps) {
  return <QuestionFlow key={props.interaction.rpcId} {...props} />
}

function QuestionFlow({ interaction, actions }: QuestionComposerProps) {
  const questions = interaction.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => questions.map(question => ({
    selected: [], custom: '', customOpen: (question.options?.length ?? 0) === 0, skipped: false,
  })))
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const question = questions[index]!
  const draft = drafts[index]!
  const hasOptions = (question.options?.length ?? 0) > 0

  const cancelFlow = (): void => {
    setBusy('cancel')
    setError(null)
    void actions.cancel(interaction).catch((cause: unknown) => {
      setBusy(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const updateDraft = (update: (current: DraftAnswer) => DraftAnswer): void => {
    setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? update(item) : item))
    setError(null)
  }

  const choose = (label: string): void => {
    updateDraft((current) => {
      const selected = question.multiSelect === true
        ? current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        : [label]
      return { selected, custom: '', customOpen: false, skipped: false }
    })
    if (question.multiSelect !== true && index < questions.length - 1) {
      setIndex(current => current + 1)
    }
  }

  const openCustom = (): void => {
    updateDraft(current => ({ ...current, selected: [], customOpen: true, skipped: false }))
  }

  const answered = (item: DraftAnswer): boolean =>
    item.selected.length > 0 || item.custom.trim() !== ''

  const completed = (item: DraftAnswer): boolean => answered(item) || item.skipped

  const submitDrafts = (values: DraftAnswer[]): void => {
    const missing = values.findIndex(item => !completed(item))
    if (missing >= 0) {
      setIndex(missing)
      setError('请先完成这道问题。')
      return
    }
    const answer: Answer = {
      answers: questions.map((item, itemIndex) => {
        const value = values[itemIndex] as DraftAnswer
        if (value.skipped) return { id: item.id, selected: [] }
        const custom = value.custom.trim()
        return {
          id: item.id,
          selected: custom === '' ? value.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
    setBusy('answer')
    setError(null)
    void actions.answer(interaction, answer).catch((cause: unknown) => {
      setBusy(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const continueFlow = (): void => {
    if (!answered(draft)) {
      setError('请选择一个选项或填写自定义答案。')
      return
    }
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      setError(null)
      return
    }
    submitDrafts(drafts)
  }

  const skipQuestion = (): void => {
    const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index
      ? {
          selected: [], custom: '',
          customOpen: (question.options?.length ?? 0) === 0,
          skipped: true,
        }
      : item)
    setDrafts(nextDrafts)
    setError(null)
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      return
    }
    submitDrafts(nextDrafts)
  }

  return (
    <div className={css.frame} data-question-rpc-id={interaction.rpcId}>
      <section className={css.card} aria-labelledby={`question-${interaction.rpcId}-${String(index)}`}>
        <header className={css.header}>
          <div className={css.headingBlock}>
            {question.header !== undefined && <div className={css.eyebrow}>{question.header}</div>}
            <h2 className={css.title} id={`question-${interaction.rpcId}-${String(index)}`}>
              <span>{question.multiSelect === true
                ? parseQuestionTitle(question.question)
                : question.question}</span>
              {question.multiSelect === true && <span className={css.multiSelectHint}>可多选</span>}
            </h2>
          </div>
          <div className={css.headerActions}>
            <span className={css.progress}>{index + 1} / {questions.length}</span>
            <button
              type="button" className={css.iconButton} aria-label="上一题"
              disabled={index === 0 || busy !== null}
              onClick={() => { setIndex(index - 1); setError(null) }}
            >
              <IconChevronLeftOutline14 />
            </button>
            <button
              type="button" className={css.iconButton} aria-label="下一题"
              disabled={index === questions.length - 1 || busy !== null}
              onClick={() => { setIndex(index + 1); setError(null) }}
            >
              <IconChevronRightOutline14 />
            </button>
            <button
              type="button" className={css.iconButton} aria-label="放弃整组问题"
              title="放弃整组问题"
              disabled={busy !== null} onClick={cancelFlow}
            >
              <IconCloseOutline16 />
            </button>
          </div>
        </header>

        <div className={css.options} role={question.multiSelect === true ? 'group' : 'radiogroup'}>
          {(question.options ?? []).map((option, optionIndex) => {
            const selected = draft.selected.includes(option.label)
            const display = parseRecommendedLabel(option.label)
            return (
              <button
                type="button" key={`${option.label}-${String(optionIndex)}`}
                className={clsx(css.option, selected && css.optionSelected)}
                role={question.multiSelect === true ? 'checkbox' : 'radio'}
                aria-checked={selected}
                aria-label={display.label}
                disabled={busy !== null}
                onClick={() => { choose(option.label) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !drafts.every(completed)) return
                  event.preventDefault()
                  submitDrafts(drafts)
                }}
              >
                <span className={css.number}>{optionIndex + 1}</span>
                <span className={css.optionCopy}>
                  <span className={css.optionLine}>
                    <span className={css.optionLabel}>{display.label}</span>
                    {display.recommended && <span className={css.badge}>推荐</span>}
                    {option.description !== undefined && (
                      <span className={css.description}>{option.description}</span>
                    )}
                  </span>
                </span>
                <span className={css.choiceIcon}>
                  {selected ? <IconCheckOutline16 /> : <IconChevronRightOutline14 />}
                </span>
              </button>
            )
          })}

          <div className={clsx(
            css.custom,
            draft.customOpen && css.customOpen,
            !hasOptions && css.customOptionless,
          )}>
            {hasOptions && (
              <button
                type="button" className={css.customTrigger}
                disabled={busy !== null} onClick={openCustom}
                aria-expanded={draft.customOpen}
              >
                <span className={css.number}><IconEditOutline16 /></span>
                <span>其他，请填写自定义答案</span>
              </button>
            )}
            {draft.customOpen && (
              <textarea
                autoFocus
                className={css.customInput}
                value={draft.custom}
                disabled={busy !== null}
                rows={2}
                placeholder="输入你的答案"
                onChange={(event) => {
                  const value = event.target.value
                  updateDraft(current => ({
                    ...current, selected: [], custom: value, customOpen: true, skipped: false,
                  }))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !isComposing(event)) {
                    event.preventDefault()
                    continueFlow()
                  }
                }}
              />
            )}
          </div>
        </div>

        <footer className={css.footer}>
          <div className={css.feedback} role="status">{error}</div>
          <div className={css.footerActions}>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={skipQuestion}>
              跳过本题
            </Button>
            <Button
              variant="primary" size="sm"
              disabled={busy !== null || !answered(draft)} onClick={continueFlow}
            >
              {busy === 'answer'
                ? '正在提交…'
                : index === questions.length - 1 ? '提交' : '下一题'}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
