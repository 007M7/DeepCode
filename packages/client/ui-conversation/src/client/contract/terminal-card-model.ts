/**
 * Pure derivation of the terminal-card props from a frozen call slice: the
 * `card:'terminal'` render intent the bash tool declares arrives on the
 * snapshot as `callView`/`resultView`, and this is the one place that turns
 * that pair into what {@link TerminalBlock} draws. Both conversation render
 * sites (the chat tool row's expanded body and the details panel's Output
 * section) call this, so the command, cwd, output and exit status they show
 * are derived once.
 * @module
 */
import type { TerminalBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveToolPath, type ToolCallBlock } from './tool-call-model.ts'

/**
 * Output lines the chat row's expanded terminal body shows before collapsing
 * the middle — half the primitive's own default, which the details panel
 * keeps. A chat row is a summary surface inside the message flow: the flow
 * must stay scannable across many calls, while the details panel is the
 * single-call reading surface. A design constant of this UI's row geometry,
 * not a deployment choice, so it is fixed here rather than a plugin Config
 * field.
 */
export const CHAT_TERMINAL_MAX_LINES = 8

/**
 * The {@link TerminalBlock} props this derivation owns. Picked off the
 * primitive's props so the two stay in step; `home` is absent because the web
 * client has no home path for the session host (a cwd renders as its last
 * path segment), and `maxLines`/`className` belong to each render site.
 */
export type TerminalCardModel = Pick<
  TerminalBlockProps,
  'command' | 'cwd' | 'output' | 'exitCode' | 'signal' | 'running'
>

/**
 * Resolve a terminal view's working directory the way the render-intent
 * contract assigns to the UI bridge: an absolute path is used as-is, a relative
 * one joins under the session workspace, and an omitted one IS the session
 * workspace. A pure presenter cannot see the session cwd, which is why this
 * resolution belongs here rather than in the tool. Without a session cwd there
 * is nothing to resolve against, so a relative path stays as authored and an
 * omitted one stays absent (the prompt row then draws a bare `$`).
 * @param viewCwd - the cwd the terminal call view carries, if any.
 * @param sessionCwd - the session workspace root, if the caller knows it.
 * @returns the working directory for the prompt label, or undefined.
 */
function resolveTerminalCwd(viewCwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (viewCwd === undefined || viewCwd === '') return sessionCwd
  if (sessionCwd === undefined || sessionCwd === '') return viewCwd
  return resolveToolPath(sessionCwd, viewCwd)
}

/**
 * Derive the terminal-card props for a tool call, or null when this call is
 * not a terminal card and belongs on the generic path.
 *
 * The call side supplies the command and its working directory; the result
 * side supplies the captured output and exit status. Three cases produce
 * null, all of them the documented generic-card default:
 *
 * - Neither side declares `card:'terminal'` — including a `card` value this
 *   UI version does not know, which arrives over the wire and therefore
 *   cannot be trusted to be one of the compiled variants.
 * - A settled call whose result view is not a terminal card: the result
 *   presentation decides how the settled call renders, and the bash tool
 *   returns a generic fenced card for an execution error or a background
 *   start, whose text and error styling the generic path preserves.
 *
 * Window truncation can drop the call head from a settled result (see
 * `ToolResultNode.call`/`callView` in dsh-client-runtime), leaving a terminal
 * result with no call side. That still renders: the command falls back to the
 * result view's replacement title, then to an empty command (the prompt line
 * draws bare), and the prompt shows no cwd.
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @param sessionCwd - the session workspace root, which resolves an omitted or
 *   relative view cwd (see {@link resolveTerminalCwd}); absent leaves both unresolved.
 * @returns the terminal-card props, or null for the generic path.
 */
export function terminalCardModel(block: ToolCallBlock, sessionCwd?: string): TerminalCardModel | null {
  const call = block.callView?.card === 'terminal' ? block.callView : null
  if (!('kind' in block)) {
    // Running: the call view exists, the result view does not yet.
    return call === null ? null : {
      command: call.title,
      cwd: resolveTerminalCwd(call.cwd, sessionCwd),
      output: undefined,
      exitCode: undefined,
      signal: undefined,
      running: true,
    }
  }
  const result = block.resultView?.card === 'terminal' ? block.resultView : null
  if (result === null) return null
  return {
    // The result's title REPLACES the pending one when the tool supplies it
    // (the presentation contract's replacement-title rule); the call title is
    // what a result without one keeps.
    command: result.title ?? call?.title ?? '',
    cwd: resolveTerminalCwd(call?.cwd, sessionCwd),
    output: result.output,
    exitCode: result.exitCode,
    signal: result.signal,
    running: false,
  }
}
