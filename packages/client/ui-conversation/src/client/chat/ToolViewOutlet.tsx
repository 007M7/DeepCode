// ToolViewOutlet: resolves the toolview for one call through ctx.toolviews
// (uSES over the registry version so unload falls back live) and renders it
// behind a per-row error boundary. GenericToolCard is the render-side
// fallback for both a registry miss and a crashed custom row. A registrant
// inject factory is called once per (registration x binding) and cached,
// mirroring the scoped-slots injection discipline.

import { Component, useSyncExternalStore, type FC, type ReactNode } from 'react'
import { useSessionBinding } from '@deepseek-ai/dsh-client-web-react'
import type { SessionBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolViewInject, ToolViewProps, ToolViewResolver } from '../contract/toolview.ts'
import { GenericToolCard } from './GenericToolCard.tsx'

export interface ToolViewOutletProps {
  registry: ToolViewResolver
  sessionId: SessionId
  toolName: string
  viewProps: ToolViewProps
}

/** Inject cache: per inject-factory (stable per registration) x binding object. */
const injectCache = new WeakMap<ToolViewInject<object>, WeakMap<object, object>>()

function cachedInject(inject: ToolViewInject<object>, binding: SessionBinding): object {
  let perBinding = injectCache.get(inject)
  if (!perBinding) {
    perBinding = new WeakMap()
    injectCache.set(inject, perBinding)
  }
  let props = perBinding.get(binding)
  if (!props) {
    props = inject(binding)
    perBinding.set(binding, props)
  }
  return props
}

class RowErrorBoundary extends Component<
  { resetKey: unknown; fallback: ReactNode; children: ReactNode }, { failed: boolean }
> {
  override state = { failed: false }
  // Fallback state MUST flip here (render phase): a boundary whose derived
  // state does not change re-renders the crashing children and React gives
  // up after the second throw, escalating past the boundary.
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(error: unknown): void {
    console.error('toolview row crashed:', error)
  }
  // A re-registration (resetKey bump) retries the custom row.
  override componentDidUpdate(prev: { resetKey: unknown }): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false })
    }
  }
  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

/** Split component: only inject-carrying registrations need the session
 *  binding hook (keeps injectless rendering free of the Provider requirement). */
function InjectedRow({ Row, inject, viewProps }: {
  Row: FC<ToolViewProps & object>; inject: ToolViewInject<object>; viewProps: ToolViewProps
}) {
  const binding = useSessionBinding()
  const injected = cachedInject(inject, binding)
  return <Row {...{ ...injected, ...viewProps }} />
}

export function ToolViewOutlet({ registry, sessionId, toolName, viewProps }: ToolViewOutletProps) {
  const version = useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => registry.getVersion(),
  )
  const resolved = registry.resolve(toolName, sessionId)
  if (resolved === undefined) return <GenericToolCard {...viewProps} />
  const Row = resolved.component
  return (
    <RowErrorBoundary resetKey={version} fallback={<GenericToolCard {...viewProps} />}>
      {resolved.inject === undefined
        ? <Row {...viewProps} />
        : <InjectedRow Row={Row} inject={resolved.inject} viewProps={viewProps} />}
    </RowErrorBoundary>
  )
}
