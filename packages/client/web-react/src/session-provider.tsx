/**
 * SessionProvider (dependency-inverted; never imports runtime) plus the two
 * binding contexts the slot outlet reads: per-session {@link BindingContext}
 * written here, and the root-binding channel written by the shell through
 * {@link RootBindingProvider}.
 */
import { createContext, useContext, type FC, type ReactNode } from 'react'
import type { RootBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionBinding, SessionProviderDeps } from './index.ts'

/** Session binding for the subtree under SessionProvider (module-private write). */
const BindingContext = createContext<SessionBinding | null>(null)

/**
 * A missing-provider assembly error: the shell wired the tree wrong. The slot
 * error boundary rethrows this class so misassembly stays fail-loud while
 * registrant errors (inject factories, entry components) are contained
 * per entry.
 */
export class SlotAssemblyError extends Error {}

/**
 * Read the enclosing session binding; throws outside a SessionProvider
 * subtree (session slots must not render without a session).
 * @returns the enclosing binding.
 */
export function useSessionBinding(): SessionBinding {
  const binding = useContext(BindingContext)
  if (!binding) throw new SlotAssemblyError('session slot rendered outside SessionProvider')
  return binding
}

const RootBindingContext = createContext<RootBinding | null>(null)

/**
 * Root-binding supply channel: the shell mounts this once at the top so root
 * slot inject factories receive their assembly handle.
 */
export const RootBindingProvider: FC<{ value: RootBinding; children?: ReactNode }> =
  ({ value, children }) => (
    <RootBindingContext.Provider value={value}>{children}</RootBindingContext.Provider>
  )

/**
 * Read the root binding; throws when the shell forgot to mount
 * {@link RootBindingProvider} (root inject factories need ctx).
 * @returns the root binding.
 */
export function useRootBinding(): RootBinding {
  const binding = useContext(RootBindingContext)
  if (!binding) throw new SlotAssemblyError('root slot inject requires RootBindingProvider above')
  return binding
}

/**
 * Build the single SessionProvider component: subscribes to the current
 * session id, resolves its binding (stable reference), remounts the body
 * under key={id}, and delegates body rendering to the assembler's renderBody
 * (slot ownership stays with layout; the provider knows no slot names).
 * @param deps - inverted dependencies.
 * @returns the provider component.
 */
export function createSessionProvider(deps: SessionProviderDeps): FC<{ renderEmpty?: () => ReactNode }> {
  return function SessionProvider({ renderEmpty }) {
    const id = deps.useCurrent()
    const binding = id === undefined ? undefined : deps.resolveBinding(id)
    if (id === undefined || !binding) return <>{renderEmpty?.() ?? null}</>
    return (
      <BindingContext.Provider value={binding} key={id}>
        {deps.renderBody(id)}
      </BindingContext.Provider>
    )
  }
}
