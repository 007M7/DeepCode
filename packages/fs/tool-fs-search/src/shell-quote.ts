/**
 * POSIX single-quoting helper retained for compatibility with older
 * deployments and tests. The current `glob`/`grep` command builders spawn the
 * packaged ripgrep binary with a plain argv vector — no shell layer exists —
 * so no quoting is involved; this module is kept because its export is part
 * of the package surface.
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
