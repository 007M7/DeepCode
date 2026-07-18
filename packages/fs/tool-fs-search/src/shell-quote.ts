/**
 * The one shell-quoting helper both search tools MUST route every
 * model-controlled value through before it enters an `rg` command string. The
 * bash seam (`ctx.bash`) accepts a command STRING, not an argv vector, so this
 * is the safety boundary that stops a `pattern`, `path`, or `include` from
 * breaking out of its argument and injecting shell syntax.
 *
 * Command builders in `glob.ts` / `grep.ts` must never hand-roll quoting or
 * concatenate an unquoted model value — they call {@link singleQuote}.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/shell-quote
 */

/**
 * POSIX single-quote a string for safe use as ONE shell word. Wraps the value
 * in single quotes and rewrites every embedded single quote as `'\''` (close
 * quote, an escaped literal quote, reopen quote). Inside single quotes the shell
 * treats every other byte literally — spaces, newlines, `$`, backticks, `;`,
 * `|`, `&`, glob metacharacters, and a leading `-` are all inert — so the result
 * is a single, injection-safe argument regardless of the input.
 *
 * @param value - the raw, possibly model-controlled string to quote.
 * @returns the value wrapped as one safe single-quoted shell word.
 */
export function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
