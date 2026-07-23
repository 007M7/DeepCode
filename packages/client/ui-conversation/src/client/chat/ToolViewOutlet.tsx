// ToolViewOutlet: resolves the toolview for one call through ctx.toolviews
// (uSES over the registry version so unload falls back live) and renders it
// behind a per-row error boundary. GenericToolCard is the render-side
// fallback for both a registry miss and a crashed custom row. Pure props
// machinery, zero React context: a registrant inject factory receives the
// sessionId this outlet already holds, is called once per (registration x
// session) and cached, mirroring the slot injection discipline.

import { Component, useSyncExternalStore, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolViewInject, ToolViewProps, ToolViewResolver } from '../contract/toolview.ts'
import { GenericToolCard } from './GenericToolCard.tsx'

export interface ToolViewOutletProps {
  registry: ToolViewResolver
  sessionId: SessionId
  toolName: string
  viewProps: ToolViewProps
}

/** Inject cache: per inject-factory (stable per registration) x session id.
 *  The inner Map lives and dies with its factory (WeakMap entry), so entries
 *  are bounded by the session count over the registration's lifetime. */
const injectCache = new WeakMap<ToolViewInject<object>, Map<SessionId, object>>()

function cachedInject(inject: ToolViewInject<object>, sessionId: SessionId): object {
  let perSession = injectCache.get(inject)
  if (!perSession) {
    perSession = new Map()
    injectCache.set(inject, perSession)
  }
  let props = perSession.get(sessionId)
  if (!props) {
    props = inject(sessionId)
    perSession.set(sessionId, props)
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
        : <Row {...{ ...cachedInject(resolved.inject, sessionId), ...viewProps }} />}
    </RowErrorBoundary>
  )
}
