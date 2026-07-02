# RFC: Tagged render-intent union for tool-call presentation

Status: implemented

## Problem

A tool declares how its calls render in a UI (an editor's tool-call card) through two callbacks, `presentCall`/`presentResult` on `ToolDefinition`, returning `ToolCallPresentation` / `ToolResultPresentation` with an optional `ToolTerminal` sub-shape. These grew incrementally into a **bag of optional fields**: `title`, `kind`, `rawInput`, `content`, `locations`, `terminal` on the call; `title`, `content`, `terminal` on the result; `cwd`/`output`/`exitCode`/`signal` on `ToolTerminal`. The split of responsibility is muddy:

- The call-side and result-side `terminal` fields overlap, and the bridge reconciles a `content` block AND a `terminal` block AND `rawInput` per call, stitching them together with ad-hoc conditionals.
- Which combinations are *valid* is unwritten: a `terminal` call that also sets `content` means "description above the card"; a generic call that sets `terminal` is meaningless but representable. The type permits nonsense.
- There is no way to express the one file-tool affordance an editor most wants — a **diff card** (`{path, oldText, newText}`, which Zed renders as an inline diff / new-file preview). `ToolCallPresentation.content` is the *LLM* `ContentBlock[]` vocabulary (text/image), so a tool literally cannot ask for a diff.

The existing `FIXME(tool-presentation)` in `packages/core/tools/src/index.ts` named the fix: "redesign the type so a tool declares its render INTENT once (e.g. a tagged union over card kinds) rather than a bag of optional fields the bridge stitches together." The rejected RFC [Collapse tool-owned UI presentation](../../rejected/simplification/2026-06-20-generic-tool-rendering.md) deferred it explicitly: rich rendering "should return later as a tagged render-intent union after there are at least two real tools and two real consumers to validate the vocabulary." That bar is now met — two producer families (`dsh-tool-bash`, `dsh-tool-fs`) and two consumers (the ACP bridge live path + the snapshot-golden replay path).

## Decision

Replace the optional-field bag with a **`card`-tagged discriminated union**. A tool declares one render intent per call/result; the bridge switches on the tag.

```ts ignore-check
type FileLocation = { path: string; line?: number }
type FileDiff = { path: string; oldText: string | null; newText: string } // oldText null ⇒ new file

// presentCall → ToolCallView
type ToolCallView = GenericCallView | TerminalCallView | DiffCallView
interface GenericCallView { card: 'generic'; title: string; kind?: ToolCallKind; rawInput?: unknown; content?: ContentBlock[]; locations?: FileLocation[] }
interface TerminalCallView { card: 'terminal'; title: string; description?: string; cwd?: string }
interface DiffCallView { card: 'diff'; title: string; diffs: FileDiff[]; locations?: FileLocation[] }

// presentResult → ToolResultView
type ToolResultView = GenericResultView | TerminalResultView
interface GenericResultView { card: 'generic'; title?: string; content?: ContentBlock[] }
interface TerminalResultView { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
```

`card` is **required** on every variant — a real discriminant, not an optional default. The bridge does `switch (view.card) { case 'generic': … case 'terminal': … case 'diff': … default: assertNever(view) }`. The union is **closed** (per the [switch-exhaustiveness convention](../../../../AGENTS.md)): a fourth render intent (a table, a chart) needs new bridge code to render it anyway, so a plugin-added variant that the bridge silently drops would be worse than a compile error. Adding a variant breaks compilation at the bridge switch — exactly the signal we want.

### Why a tagged union beats the field-bag

- **Invalid states become unrepresentable.** A generic card cannot carry terminal output; a terminal card cannot carry a diff. The old bag permitted all of these.
- **The bridge switches instead of stitching.** One arm per card kind, each producing exactly the wire shape that card needs, rather than reconciling five optional fields whose interactions are undocumented.
- **`diff` is a first-class intent.** `dsh-tool-fs` write/edit declare `card:'diff'`; the bridge emits an ACP `{type:'diff', path, oldText, newText}` `ToolCallContent` (already in the SDK's `ToolCallContent` union, previously unused by the bridge). This is the affordance the redesign unlocks.

### Producer mapping

- `dsh-tool-fs` read → `generic` (`kind:'read'`, a follow-along `location`); write → `diff` (`oldText:null`); edit → `diff` (`oldText:old_string || null`, `newText:new_string ?? ''`). This mirrors `claude-agent-acp`'s `toolInfoFromToolUse` Read/Write/Edit arms field-for-field.
- `dsh-tool-bash` foreground → `terminal` call + `terminal` result; `run_in_background` and `bash_output`/`bash_kill` → `generic`.
- `dsh-tool-todo` → `generic`.

### Terminal fallback ownership

`TerminalResultView` carries only `output`/`exitCode`/`signal`. A UI without the terminal capability needs a fenced ` ```console ` text fallback; that derivation moves to the **bridge** (it wraps `output` in a fenced block on the no-capability path), rather than the tool double-encoding it. This keeps the bash tool's result a single structured shape and preserves the existing capability-gated behavior byte-for-byte.

### Purity preserved

`presentCall`/`presentResult` remain pure functions of `args` (+ the result for `presentResult`) — they run on live streaming AND session-log replay, so they must be replay-deterministic. Every view is derived from args alone: write's diff is new-file style (`oldText:null`) because the tool has no old content at call time; edit's diff is `old_string`→`new_string`.

## Relative-path display titles

`claude-agent-acp` relativizes a file card's title path against the session cwd (`toDisplayPath`) — `Read src/foo.ts`, not `/abs/proj/src/foo.ts` — while keeping `locations[]`/`diff.path` **raw** (the editor opens the real path). Our `presentCall` is pure/args-only and cannot see the session cwd, so this relativization happens at the **bridge**, which already threads the session cwd into tool-call rendering (the same cwd it uses to resolve a terminal card's header). The bridge relativizes the title only, by an exact structured replace of the known `locations[0].path`/`diffs[0].path` substring — generic over the file-card kinds, never special-casing tool names.

## Non-goals

- **Applied-hunk diffs.** `claude-agent-acp` additionally rewrites Write/Edit diffs at *result* time with real structured-patch hunks (via a PostToolUse hook: `toolUpdateFromDiffToolResponse`). Our diffs are call-time and args-derived (the whole `old_string`→`new_string`, no surrounding context lines), because `presentResult` sees only `{content, isError}` and `FsEditOutcome` carries a replacement count/version, not hunk text. Real hunks would need a new result/event shape carrying the patch — a follow-up, not this change. This is the one remaining representation difference from `claude-agent-acp`, and it is architectural (needs a new event), not cosmetic.
- **Live incremental `terminal_output_delta` streaming** and **command classification** — the terminal-rendering RFC's own deferred follow-ups, untouched here.

## Related

- Supersedes the deferral in [Collapse tool-owned UI presentation](../../rejected/simplification/2026-06-20-generic-tool-rendering.md) (rejected — "wait for two real tools and two real consumers, then a tagged render-intent union"). That bar is now met; this is that union.
- Folds `ToolTerminal` into the `terminal` views described by [ACP terminal and tool-call rendering](../feature/2026-06-18-acp-terminal-and-tool-rendering.md) (the `_meta` terminal-card convention and capability gate are unchanged; only the harness-side presentation type changes).
- The ACP SDK's `Diff` / `ToolCallContent` types back the new `diff` card.
