# @deepseek-ai/dsh-client-ui-primitives

English | [中文](README.zh.md)

Pure React atoms (zero cordis): StateDot, ic_ds_* icons, Button/Pill/Menu/Modal/Input, the markdown family (MessageText/MarkdownText/JsonBlock), the read-only JsonTree inspector, and TerminalBlock. Contract: api-contracts v3 §8.

## Markdown rendering

`MarkdownText` renders GFM from untrusted assistant output through React elements. It omits raw HTML, neutralizes relative and non-HTTP(S)/mailto links, opens HTTP(S) links with safe external-link attributes, and renders image alt text without loading remote resources; `MessageText` remains the literal-text primitive for user-authored content. `extractMarkdownPlainText` removes Markdown presentation markup for compact labels while preserving raw HTML as literal text. Element spacing, tables, links, and inline code use the same `--dsw-alias-markdown-*` / `--dsw-font-markdown-*` tokens as deepsuite `@deepseek/md`. Fenced blocks render through `CodeBlock` (language banner, copy control, shiki for the registered grammars).

## Terminal output

`TerminalBlock` renders a shell command as a terminal surface: one prompt row per line of the command (the shortened `cwd` label on the first row only, since the view knows one working directory and a `cd` moves later lines elsewhere, then that line), the command's output, a status pill for a non-zero exit code or a terminating signal, and a copy control that writes the raw `output` prop. A run-state `StateDot` marks the call once, on the first row, out of flow in a gutter the card reserves as its own left padding, so the dot sits inside the card box yet left of the prompt text. It reaches three of `StateDot`'s states — the chase while `running`, red for the same exit status that renders the pill, green otherwise — so a card states whether its command is still running rather than leaving that to be inferred from the presence of output; it carries one visually hidden text label because `StateDot` is `aria-hidden`. One dot regardless of line count is deliberate: the exit status is the whole call's, so a dot per line would claim a per-line outcome the view does not carry. Command text is `white-space: pre`, so repeated spaces, tabs, and an indented continuation render verbatim while the row stays single-line and ellipsizes. ANSI escape sequences are parsed with the `anser` runtime dependency into React spans; cursor movements replay into a per-line column buffer before inert controls are stripped, since carriage return and backspace only MOVE the cursor: `100%` + CR + `OK` alone shows `OK0%`, while the `\x1b[K` a spinner writes with its redraw erases the tail so `100%\r\x1b[KOK` shows `OK`. Erase-in-line is honored in all three parameter forms, the cursor advances by terminal columns (8-column tab stops, two for emoji and CJK, none for a combining mark), and SGR state is normalized per cell as a terminal stores it, threading across lines and closing at the state the line ended in; basic-16 foreground colors map onto `--dsw-*` tokens, while 256-palette and truecolor values pass through as literal rgb. Output keeps `white-space: pre` with horizontal scrolling, so column-aligned output holds its alignment instead of soft-wrapping, and collapses to a head slice plus a tail slice past `maxLines` (default 16, the TUI transcript's split arithmetic) behind an expand button. Rationale: [the web terminal card note](../../../.agents/notes/implemented/feature/2026-07-28-web-terminal-card.md).

## Model Experience

None, as the package renders pure React atoms in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Glyph-level icons are redrawn approximations** — the fish logo (and the sparkle held by ui-conversation) come from font glyphs whose vector geometry is not exportable from the local design data; hand-authored recreations stand in until an exact export path exists.
- **Pill and Input have no design source** — both atoms are self-defined; the sidebar search field and view-tab strip that resemble them are consumer-owned compositions, not these atoms.
- **StateDot `Active` variant is a hidden placeholder in the design** — not implemented; the four shipped states (done/warning/ongoing/error) are the complete P-I surface.
- **This package's user-facing copy is inline Chinese, not localized** — the atoms are zero-cordis and so cannot reach `ctx.locale`; `TerminalBlock`'s exit-code and signal pills, its copy and expand controls, and `CodeBlock`'s copy control are all hardcoded. This matches the repo-wide state the locale package records (only the Settings surface is translated); extracting these into the `zh`/`en` dictionaries needs a localization channel for zero-cordis atoms and belongs to that repo-wide extraction.
- **`TerminalBlock` is not a terminal emulator** — it renders settled or still-running command output, not an interactive session: SGR color and attributes are honored, and so are the in-line cursor movements a progress line uses — carriage return, backspace, erase-in-line, tab stops and character width. Absolute cursor positioning, screen clearing, and alternate-screen sequences are stripped. Basic-16 magenta and cyan have no token equivalent and stay literal rgb.
