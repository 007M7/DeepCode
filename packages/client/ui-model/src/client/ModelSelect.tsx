/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Compact trigger + upward provider-grouped single-select menu, revived from
 * the original PR #600 ModelSelector form. Data and submission ride the SAME
 * per-session ModelDirectory as the /model popup — one shared current, one
 * catalog load path, one selectModel route: a switch in either entry is what
 * the other shows next.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelTarget } from '@deepseek-ai/dsh-client-connection/client'
import { IconCheckOutline16, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

type FocusPreference = 'current' | 'first' | 'last'

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory store/verbs).
 * @returns the trigger and, while open, the upward menu.
 */
export function ModelSelect({ locked, directory, load, select }: ModelSelectInjected & { locked: boolean }) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const pendingFocus = useRef<FocusPreference | null>(null)
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      target: { provider: group.id, model: model.id } satisfies ModelTarget,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.target.provider === state.current?.provider && c.target.model === state.current.model)
  const busy = state.status === 'selecting'

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => { load() }, [load])

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
    load()
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
    if (state.current?.provider === target.provider && state.current.model === target.model) {
      close(true)
      return
    }
    void select(target).then((accepted) => {
      if (accepted && rootRef.current !== null) close(true)
    })
  }

  const label = choices[selectedIndex]?.model.name ?? state.current?.model ?? '选择模型'

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
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
          aria-busy={state.status === 'loading' || busy}
        >
          {state.status === 'loading' && (
            <div className={css.status}>正在刷新模型列表…</div>
          )}
          {state.error !== null && (
            <div className={css.error}>
              <span>模型操作失败：{state.error}</span>
              <button type="button" className={css.retry} onClick={() => { load() }}>重试</button>
            </div>
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{failure.name} 加载失败：{failure.message}</span>
              <button type="button" className={css.retry} onClick={() => { load() }}>重试</button>
            </div>
          ))}

          <div className={clsx(css.groups, 'scrollable')}>
            {state.groups.map((group) => {
              const headingId = `${id}-${group.id}`
              return (
                <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                  <div className={css.groupTitle} id={headingId}>{group.name}</div>
                  {group.models.map((model) => {
                    const index = choices.findIndex(c => c.target.provider === group.id && c.target.model === model.id)
                    const selected = state.current?.provider === group.id && state.current.model === model.id
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

          {state.status === 'ready' && choices.length === 0 && (
            <div className={css.empty}>没有可用的模型。</div>
          )}
        </div>
      )}
    </div>
  )
}
