/**
 * The client's ONE syntax highlighter: a synchronous fine-grained shiki core
 * (JavaScript regex engine — no oniguruma WASM, bundle-friendly) with an
 * explicit grammar allowlist and a CSS-variables theme. Colors live in the
 * theme package's token sheets as `--shiki-*` custom properties (light and
 * dark blocks), never here — the repo's tokens-only styling rule.
 *
 * Grammars are the set the harness actually renders: TypeScript programs
 * (`run_code` bodies; TS pulls in JS via grammar embedding), shell commands,
 * and JSON payloads. An unknown or absent language falls back to plain text
 * (no highlighting, still monospace) — never an error.
 */

import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'
import type { HighlighterCore } from 'shiki/core'

/** Language ids (and aliases) the singleton registers; everything else renders plain. */
const LANG_ALIASES: Record<string, string> = {
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  javascript: 'typescript',
  js: 'typescript',
  shellscript: 'shellscript',
  bash: 'shellscript',
  sh: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  json: 'json',
  jsonc: 'json',
}

/** All token colors resolve through `--shiki-*` custom properties (theme package sheets). */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

let singleton: HighlighterCore | undefined

/** The lazily-created synchronous highlighter (one instance per document). */
function highlighter(): HighlighterCore {
  singleton ??= createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: [langTs, langBash, langJson],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return singleton
}

/**
 * Highlight `code` into shiki's HTML (a single `<pre class="shiki">` tree)
 * when `lang` maps to a registered grammar; `undefined` means the caller
 * renders its plain fallback.
 * @param code - the source text.
 * @param lang - the language hint (a markdown fence info string or a fixed caller id).
 * @returns the highlighted HTML, or `undefined` for unknown languages.
 */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES[lang.toLowerCase()]
  if (resolved === undefined) return undefined
  return highlighter().codeToHtml(code, { lang: resolved, theme: 'css-variables' })
}
