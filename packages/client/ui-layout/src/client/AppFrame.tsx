/**
 * Three-column shell frame. Owns the grid tracks (sidebar | center | details),
 * the two drag handles (pointer capture + rAF throttle), and the concession
 * chain (columns.ts). Column content arrives via props: `sidebar` is the
 * sidebar slot render, `children` is the session area (the shell mounts
 * SessionProvider there; its body renders {@link CenterColumn} and
 * {@link DetailsColumn}, which land as grid items because neither the provider
 * nor fragments emit DOM). Zero cordis imports — stores and actions are
 * injected as props.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { computeColumns } from './columns.ts'
import type { PanelState } from './service.ts'
import css from './AppFrame.module.css'

/** AppFrame props: injected viewing-state hooks, stable width actions, column content. */
export interface AppFrameProps {
  /** Selector hook over the sidebar panel store. */
  useSidebar: SnapshotSelectorHook<PanelState>
  /** Selector hook over the details panel store. */
  useDetails: SnapshotSelectorHook<PanelState>
  /** Persist a sidebar width preference (service clamps). */
  setSidebarWidth: (px: number) => void
  /** Persist a details width preference (service clamps). */
  setDetailsWidth: (px: number) => void
  /** Sidebar column content (shell: renderSlot('sidebar')). */
  sidebar: ReactNode
  /** Session area (shell: SessionProvider whose body renders CenterColumn + DetailsColumn). */
  children?: ReactNode
}

/** Center column grid item; rendered inside the session provider's body. */
export function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
export function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/** One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin. */
function DragHandle(props: { left: number; onStart: () => void; onDrag: (dx: number) => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame(props: AppFrameProps) {
  const sidebar = props.useSidebar((s) => s)
  const details = props.useDetails((s) => s)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  const cols = computeColumns(viewport, sidebar, details)
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the persisted preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const { setSidebarWidth, setDetailsWidth } = props
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    setSidebarWidth(sidebarBase.current + dx)
  }, [setSidebarWidth])
  const onDetailsDrag = useCallback((dx: number) => {
    setDetailsWidth(detailsBase.current - dx)
  }, [setDetailsWidth])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` }}
      data-sidebar-collapsed={cols.sidebar === 0 || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
    >
      <div className={css.sidebarCol}>{props.sidebar}</div>
      {props.children}
      {cols.sidebar > 0 && <DragHandle left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} />}
      {cols.details > 0 && <DragHandle left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} />}
    </div>
  )
}
