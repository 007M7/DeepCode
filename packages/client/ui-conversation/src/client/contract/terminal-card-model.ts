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
import type { ToolCallBlock } from './tool-call-model.ts'

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
 * @returns the terminal-card props, or null for the generic path.
 */
export function terminalCardModel(block: ToolCallBlock): TerminalCardModel | null {
  const call = block.callView?.card === 'terminal' ? block.callView : null
  if (!('kind' in block)) {
    // Running: the call view exists, the result view does not yet.
    return call === null ? null : {
      command: call.title,
      cwd: call.cwd,
      output: undefined,
      exitCode: undefined,
      signal: undefined,
      running: true,
    }
  }
  const result = block.resultView?.card === 'terminal' ? block.resultView : null
  if (result === null) return null
  return {
    command: call?.title ?? result.title ?? '',
    cwd: call?.cwd,
    output: result.output,
    exitCode: result.exitCode,
    signal: result.signal,
    running: false,
  }
}
