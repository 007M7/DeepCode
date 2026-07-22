/**
 * Shell root: boot loading page → (loader settled) → real UI in one switch.
 * Pure shell component with zero plugin dependencies — before settled it may
 * only rely on itself; the real UI is produced by the boot assembly closure
 * (renderApp) once every plugin is active. A failed plugin keeps the loading
 * page and lists the failures (fail loud, no partial UI).
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import type { LoaderStatus } from '@deepseek-ai/dsh-client-runtime/client'
import css from './AppRoot.module.css'

/** AppRoot props: settled signal, loader status feed, deferred real-UI factory. */
export interface AppRootProps {
  /** True once loader.settled() resolved (the boot closure flips it; status-derived guesses race an incrementally filled table). */
  settled: ObservableSnapshot<boolean>
  /** Loader per-plugin status store (drives loading/failed rendering). */
  status: SnapshotStore<LoaderStatus>
  /** Builds the real UI; called only after settled. */
  renderApp: () => ReactNode
}

/** Boot gate: loading page until the loader settles; failures stay here. */
export function AppRoot(props: AppRootProps) {
  const settled = useSyncExternalStore(props.settled.subscribe, props.settled.getSnapshot)
  const status = useSyncExternalStore(props.status.subscribe, props.status.getSnapshot)
  const failed = Object.entries(status).filter(([, s]) => s === 'failed')

  if (settled) return <>{props.renderApp()}</>

  return (
    <div className={css.boot}>
      <div className={css.card}>
        <div className={css.wordmark}>HARNESS</div>
        {failed.length === 0
          ? (
              <>
                <div className={css.spinner} />
                <div className={css.hint}>Loading plugins…</div>
              </>
            )
          : (
              <div className={css.failed}>
                <div className={css.failedTitle}>Failed to load plugins</div>
                {failed.map(([id]) => <div key={id} className={css.failedItem}>{id}</div>)}
              </div>
            )}
      </div>
    </div>
  )
}
