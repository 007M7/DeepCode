/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; effort is a client-local display echo until a wire carries
 * a per-session override (see the directory's state contract).
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelTarget } from '@deepseek-ai/dsh-client-connection/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelEffort } from './directory.ts'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** The displayable effort levels (deepseek wire vocabulary, capitalized for the UI). */
const EFFORT_LEVELS: readonly { id: ModelEffort; label: string }[] = [
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
]

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory store/verbs).
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect({ locked, directory, load, select, setEffort }: ModelSelectInjected & { locked: boolean }) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
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
  const effortLabel = EFFORT_LEVELS.find(l => l.id === state.effort)?.label ?? 'High'

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

  const show = (): void => {
    setPane('root')
    setOpen(true)
    load()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
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

  const modelLabel = choices[selectedIndex]?.model.name ?? state.current?.model ?? '选择模型'
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={`选择模型，当前 ${modelLabel}，effort ${effortLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={`${modelLabel} · ${effortLabel}`}
        disabled={locked}
        onClick={() => { open ? close() : show() }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        <span className={css.triggerEffort}>{effortLabel}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label="模型与 effort"
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => setPane('model')}>
                <span className={css.cellLabel}>Model</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => setPane('effort')}>
                <span className={css.cellLabel}>Effort</span>
                <span className={css.cellValue}>{effortLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
            </>
          )}

          {pane === 'model' && (
            <>
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
                        const selected = state.current?.provider === group.id && state.current.model === model.id
                        return (
                          <button
                            ref={itemRef()}
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
            </>
          )}

          {pane === 'effort' && EFFORT_LEVELS.map(level => (
            <button
              ref={itemRef()}
              type="button"
              role="menuitemradio"
              aria-checked={state.effort === level.id}
              className={clsx(css.option, state.effort === level.id && css.selected)}
              key={level.id}
              onClick={() => { setEffort(level.id); close(true) }}
            >
              <span className={css.optionCopy}>
                <span className={css.modelName}>{level.label}</span>
              </span>
              <span className={css.check}>
                {state.effort === level.id ? <IconCheckOutline16 /> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
