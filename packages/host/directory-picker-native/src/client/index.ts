/**
 * Browser half of the native directory-picker backend: fills ui-workspace's
 * two directory-flow holes with a renderless occupant that answers each
 * `open` by driving `host.pickDirectory` (the node half's OS chooser) and
 * reporting the one outcome — picked path, cancellation, or failure — back
 * through the owner conversation. Mounting this package therefore composes
 * both sides of the native interaction with one cordis.yml row; no client
 * code branches on a capability kind.
 */
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { deferRegistration } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the SlotMap merge declaring the directory-flow holes and their owner contract.
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Injected face: the wire call the flow drives (bound in apply's closure). */
interface NativeFlowInjected {
  /** Ask the local Host to open its native single-directory chooser. */
  pick: () => Promise<string | null>
}

/**
 * Renderless flow occupant: each rising `open` edge runs exactly one pick and
 * reports exactly one outcome; the ref arms once per open so re-renders (and
 * an adoption keeping `open` true while `busy`) never launch a second
 * chooser. The owner withdrawing `open` re-arms the next request.
 * @param props - owner conversation plus the injected pick call.
 * @returns nothing — the native chooser renders on the host display.
 */
export function NativeDirectoryFlow(props: DirectoryFlowOwnerProps & NativeFlowInjected): ReactElement | null {
  const { open, pick } = props
  const armed = useRef(false)
  // Callbacks ride a ref so the settled pick reports through the owner's
  // latest handlers, not the ones captured when the chooser opened.
  const outcome = useRef(props)
  outcome.current = props
  useEffect(() => {
    if (!open) {
      armed.current = false
      return
    }
    if (armed.current) return
    armed.current = true
    pick().then(
      (path) => { if (path === null) outcome.current.onCancel(); else outcome.current.onPicked(path) },
      (reason: unknown) => { outcome.current.onError(reason instanceof Error ? reason.message : String(reason)) },
    )
  }, [open, pick])
  return null
}

/** Required services (cordis fiber inject): the slot registry and the wire-facing workspace service. */
export const inject = ['slots', 'workspaces']

/**
 * Client plugin body: register the renderless native flow into both
 * directory-flow holes (declaration-aware deferral — the declaring
 * ui-workspace entries may activate later, and an HMR collapse re-declares).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): NativeFlowInjected => ({ pick: () => ctx.workspaces.pickDirectory() })
  ctx.effect(() => {
    const deferred = [
      deferRegistration(ctx.slots, 'conversation.hero.workspace.directoryFlow', NativeDirectoryFlow, () =>
        ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, NativeDirectoryFlow)),
      deferRegistration(ctx.slots, 'sidebar.workspaces.directoryFlow', NativeDirectoryFlow, () =>
        ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, NativeDirectoryFlow)),
    ]
    return () => { for (const entry of deferred) entry.dispose() }
  }, 'directory-picker-native: flow registrations')
}
