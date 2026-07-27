import {
  useEffect, useId, useMemo, useRef, useState,
  type FocusEvent, type KeyboardEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelTarget } from '@deepseek-ai/dsh-client-connection/client'
import {
  IconCheckOutline16, IconChevronDownOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelectorProps } from './contract.ts'
import css from './ModelSelector.module.css'

type FocusPreference = 'current' | 'first' | 'last'

/** Session-scoped provider-grouped model selector for the composer action row. */
export function ModelSelector({
  useSession, locked, refreshModels, retryModelOperation, selectModel,
}: ModelSelectorProps) {
  const selection = useSession(snapshot => snapshot.modelSelection)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const pendingFocus = useRef<FocusPreference | null>(null)
  const id = useId()
  const { choices, choiceIndices } = useMemo(() => {
    const nextChoices = selection.groups.flatMap(group =>
      group.models.map(model => ({
        group,
        model,
        target: { provider: group.id, model: model.id } satisfies ModelTarget,
      })))
    return {
      choices: nextChoices,
      choiceIndices: new Map(nextChoices.map((choice, index) => [
        JSON.stringify([choice.target.provider, choice.target.model]),
        index,
      ])),
    }
  }, [selection.groups])
  const selectedIndex = selection.current === null
    ? -1
    : choiceIndices.get(JSON.stringify([
        selection.current.provider,
        selection.current.model,
      ])) ?? -1
  const busy = selection.status === 'selecting'

  useEffect(() => {
    refreshModels()
  }, [refreshModels])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useEffect(() => {
    const preference = pendingFocus.current
    if (!open || preference === null || choices.length === 0) return
    const index = preference === 'first'
      ? 0
      : preference === 'last'
        ? choices.length - 1
        : selectedIndex >= 0 ? selectedIndex : 0
    itemRefs.current[index]?.focus()
    pendingFocus.current = null
  }, [choices.length, open, selectedIndex])

  const show = (preference: FocusPreference | null = null): void => {
    pendingFocus.current = preference
    setOpen(true)
    refreshModels()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    pendingFocus.current = null
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    if (choices.length === 0) return
    const active = itemRefs.current.findIndex(item => item === document.activeElement)
    const origin = active >= 0 ? active : selectedIndex >= 0 ? selectedIndex : 0
    const next = (origin + offset + choices.length) % choices.length
    itemRefs.current[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      itemRefs.current[event.key === 'Home' ? 0 : choices.length - 1]?.focus()
    }
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!open) {
      show(event.key === 'ArrowDown' ? 'first' : 'last')
      return
    }
    pendingFocus.current = 'current'
    const index = selectedIndex >= 0 ? selectedIndex : 0
    itemRefs.current[index]?.focus()
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const choose = (target: ModelTarget): void => {
    if (
      selection.current?.provider === target.provider
      && selection.current.model === target.model
    ) {
      close(true)
      return
    }
    void selectModel(target).then((accepted) => {
      if (accepted && rootRef.current !== null) close(true)
    })
  }

  const retry = (): void => {
    void retryModelOperation().then((selected) => {
      if (selected && rootRef.current !== null) close(true)
    })
  }

  const currentProviderKnown = selection.current === null
    || selection.groups.some(group => group.id === selection.current?.provider)
    || selection.failures.some(failure => failure.id === selection.current?.provider)
  const label = choices[selectedIndex]?.model.name ?? selection.current?.model ?? '选择模型'

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={`选择模型，当前 ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={label}
        disabled={locked}
        onClick={() => { open ? close() : show() }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={css.triggerLabel}>{label}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label="模型"
          aria-busy={selection.status === 'loading' || busy}
        >
          {selection.status === 'loading' && (
            <div className={css.status}>正在刷新模型列表…</div>
          )}
          {selection.error !== null && (
            <div className={css.error}>
              <span>模型操作失败：{selection.error.message}</span>
              <button type="button" className={css.retry} onClick={retry}>重试</button>
            </div>
          )}
          {selection.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{failure.name} 加载失败：{failure.message}</span>
              <button type="button" className={css.retry} onClick={refreshModels}>重试</button>
            </div>
          ))}
          {selection.status !== 'loading' && !currentProviderKnown && selection.current !== null && (
            <div className={css.warning}>
              当前提供方 {selection.current.provider} 未注册。
            </div>
          )}

          <div className={clsx(css.groups, 'scrollable')}>
            {selection.groups.map((group) => {
              const headingId = `${id}-${group.id}`
              return (
                <section
                  role="group"
                  aria-labelledby={headingId}
                  className={css.group}
                  key={group.id}
                >
                  <div className={css.groupTitle} id={headingId}>{group.name}</div>
                  {group.models.map((model) => {
                    const index = choiceIndices.get(JSON.stringify([group.id, model.id])) ?? -1
                    const selected = selection.current?.provider === group.id
                      && selection.current.model === model.id
                    return (
                      <button
                        ref={(node) => { itemRefs.current[index] = node }}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={clsx(css.option, selected && css.selected)}
                        key={model.id}
                        title={model.name}
                        disabled={busy}
                        onClick={() => { choose({ provider: group.id, model: model.id }) }}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{model.name}</span>
                          {model.description !== undefined && (
                            <span className={css.description}>{model.description}</span>
                          )}
                          {model.unlisted === true && (
                            <span className={css.unlisted}>当前模型 · 未列入目录</span>
                          )}
                        </span>
                        <span className={css.check}>
                          {selected ? <IconCheckOutline16 /> : null}
                        </span>
                      </button>
                    )
                  })}
                </section>
              )
            })}
          </div>

          {selection.status === 'ready' && choices.length === 0 && (
            <div className={css.empty}>没有可用的模型。</div>
          )}
        </div>
      )}
    </div>
  )
}
