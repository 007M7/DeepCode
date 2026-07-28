// TerminalBlock: the terminal surface for a shell command and its output —
// prompt line (run-state dot + shortened cwd + command), ANSI-colored output,
// settled exit status, and a copy control for the raw output. Output never soft-wraps:
// column-aligned output (ls, tables, box drawing) keeps its alignment and
// scrolls horizontally instead of folding. Colors resolve through --dsw-*
// tokens; ANSI parsing lives in ansi.ts.

import { useCallback, useMemo, useState } from 'react'
import clsx from 'clsx'
import { parseAnsiLines, type AnsiLine } from './ansi.ts'
import { writeClipboard } from './clipboard.ts'
import { Pill } from './Pill.tsx'
import { StateDot, type StateDotState } from './StateDot.tsx'
import css from './TerminalBlock.module.css'

/**
 * Output lines shown before the height cap collapses the middle. Matches the
 * TUI transcript's default tool-output budget so both front ends cut a long
 * command's output at the same place.
 */
export const DEFAULT_TERMINAL_MAX_LINES = 16

export interface TerminalBlockProps {
  /** The command line, rendered verbatim after the prompt label. */
  command: string
  /** Working directory for the prompt label; absent renders a plain `$`. */
  cwd?: string | undefined
  /** Absolute home directory, so a cwd equal to it collapses to `~`; absent disables that collapse. */
  home?: string | undefined
  /** The command's output text; may contain ANSI escape sequences. */
  output?: string | undefined
  /** Settled exit code; a non-zero value renders the status pill. */
  exitCode?: number | undefined
  /** Settled terminating signal name; any value renders the status pill, taking precedence over the exit code. */
  signal?: string | undefined
  /** The command is still running: the block shows the prompt line alone. */
  running?: boolean | undefined
  /** Height cap in output lines before the middle collapses (default {@link DEFAULT_TERMINAL_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/**
 * Prompt label for a working directory: `~` for the home directory itself,
 * otherwise the path's last segment (both separators accepted, trailing
 * separators ignored), falling back to the path itself when it has no
 * segment.
 * @param cwd - the working directory path.
 * @param home - absolute home directory, when the caller knows it.
 * @returns the prompt label.
 */
function promptLabel(cwd: string, home: string | undefined): string {
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (home !== undefined && trimmed === home.replace(/[/\\]+$/, '')) return '~'
  const segment = trimmed.split(/[/\\]/).pop()
  return segment === undefined || segment === '' ? cwd : segment
}

/**
 * Status pill text for a settled command, or undefined when the command
 * settled cleanly (exit 0, no signal) and needs no pill — the same
 * distinction the bash tool's own exit-status markers draw.
 * @param exitCode - settled exit code, when known.
 * @param signal - settled terminating signal name, when known.
 * @returns the pill text, or undefined for a clean exit.
 */
function statusText(exitCode: number | undefined, signal: string | undefined): string | undefined {
  if (signal !== undefined) return `信号 ${signal}`
  if (exitCode !== undefined && exitCode !== 0) return `退出码 ${exitCode}`
  return undefined
}

/**
 * Run-state indicator for the command, shown at the head of the prompt line so
 * the card states whether the command is still running without the reader
 * having to infer it from the presence of output. Three of {@link StateDotState}'s
 * four states are reachable: the spinning ring while running (the same
 * indicator a running tool row's leading icon uses, so the row and its card
 * never disagree), green for a clean settle, red for a signal or a non-zero
 * exit — the same status distinction {@link statusText} draws for the pill. A
 * settled command whose exit status never reached the view counts as a clean
 * settle: the view says it finished and says nothing went wrong.
 * @param running - the command has not settled.
 * @param exitCode - settled exit code, when known.
 * @param signal - settled terminating signal name, when known.
 * @returns the dot's state and its text label, since the dot is aria-hidden.
 */
function runState(
  running: boolean,
  exitCode: number | undefined,
  signal: string | undefined,
): { state: StateDotState; label: string } {
  if (running) return { state: 'ongoing', label: '运行中' }
  if (statusText(exitCode, signal) !== undefined) return { state: 'error', label: '失败' }
  return { state: 'done', label: '已完成' }
}

/**
 * Render one parsed output line. Runs without SGR state render as bare text,
 * so uncolored output carries no span wrappers.
 * @param line - the line's styled runs.
 * @returns the line's children.
 */
function renderLine(line: AnsiLine) {
  return line.map((span, index) => span.style === undefined
    ? span.text
    : <span key={index} style={span.style}>{span.text}</span>)
}

/**
 * Render a shell command as a terminal surface.
 * @param props - see {@link TerminalBlockProps}.
 * @returns the terminal block element.
 */
export function TerminalBlock({
  command,
  cwd,
  home,
  output,
  exitCode,
  signal,
  running = false,
  maxLines = DEFAULT_TERMINAL_MAX_LINES,
  className,
}: TerminalBlockProps) {
  const text = output ?? ''
  // A command's output ends with a newline; that terminator is not an extra
  // blank line to draw or to count against the height cap. The copy control
  // still copies `text` untouched.
  const lines = useMemo(() => parseAnsiLines(text.endsWith('\n') ? text.slice(0, -1) : text), [text])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    // The raw output, never the rendered tree: the prompt line and the status
    // pill are chrome the user did not run.
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, text])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  const status = statusText(exitCode, signal)
  const state = runState(running, exitCode, signal)
  const empty = text.trim() === ''
  const hidden = lines.length - maxLines
  const capped = hidden > 0 && !expanded
  // Same split arithmetic as the TUI transcript's collapsed tool card, so a
  // command's head and tail slices agree between the two front ends.
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines

  return (
    <div className={clsx(css.block, className)} data-terminal="" data-running={running ? '' : undefined}>
      <div className={css.header}>
        <div className={css.prompt}>
          <StateDot state={state.state} className={css.runState} />
          <span className={css.runStateLabel}>{state.label}</span>
          <span className={css.cwd}>{cwd === undefined ? '$' : promptLabel(cwd, home)}</span>
          <span className={css.command}>{command}</span>
        </div>
        {status !== undefined && <Pill className={css.status}>{status}</Pill>}
        {!running && !empty && (
          <button type="button" className={css.copyButton} onClick={onCopy}>
            {copied ? '复制成功' : '复制'}
          </button>
        )}
      </div>
      {!running && (empty
        ? <div className={css.empty}>无输出</div>
        : (
          <div className={css.output}>
            {(capped ? lines.slice(0, headLines) : lines).map((line, index) => (
              <div key={index} className={css.line}>{renderLine(line)}</div>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                className={css.expand}
                aria-expanded={expanded}
                aria-label={expanded ? '收起输出' : `展开其余 ${hidden} 行输出`}
                onClick={onToggle}
              >
                {expanded ? '收起' : `… 其余 ${hidden} 行`}
              </button>
            )}
            {capped && lines.slice(lines.length - tailLines).map((line, index) => (
              <div key={index} className={css.line}>{renderLine(line)}</div>
            ))}
          </div>
        ))}
    </div>
  )
}
