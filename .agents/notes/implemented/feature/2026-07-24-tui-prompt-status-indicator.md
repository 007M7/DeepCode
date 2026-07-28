# Agent Note: TUI prompt status indicator

Status: implemented

English | [中文](2026-07-24-tui-prompt-status-indicator.zh.md)

## Problem

While a turn runs, the input prompt shows only its static `dsh>` prefix. The assistant header carries the elapsed timing, but the editor row — where the user's attention rests — gives no live signal of what the agent is doing right now: waiting for the first token, thinking, responding, or running tools.

## Decision

While the agent is running, a phase-specific glyph replaces the `>` caret of the built-in `${indicator}` prompt value. The `inputPrompt` theme template defaults to `${symbol} ${indicator}`, where the built-in `${symbol}` value holds the `dsh` label and `${indicator}` holds the caret slot with its trailing gap before the cursor; the template literal space separates them, rendering `dsh <glyph> ` in every state. The phase is the open step's active timing bucket, derived from the same session events and rules that drive the [message header timing](2026-07-24-tui-message-header-timing.md) — no new phase model. One glyph per bucket: `◍` model wait (pre-first-token), `✻` thinking, `●` responding, `⚙` tools. A running turn with no open step falls back to the model-wait glyph; an idle agent restores the plain `>`.

The glyph occupies the caret's exact column with the same display width every frame, so the cursor never shifts as the phase changes or the glyph animates. Activity is conveyed by a brightness pulse, not by appearing and disappearing: a four-frame triangle wave (dim → normal → bold → normal) wraps the accent-colored glyph in the true SGR intensity codes (2 and 1) — never the palette's semantic `dim` role, which on a light scheme is a color the glyph's own accent would override — so the pulse survives every terminal scheme. The render-clock cadence is 250 ms per frame, a fixed presentation rhythm alongside the sibling 100 ms status refresh, not a deployment choice. The running-status timer refreshes every 100 ms tick unconditionally rather than only when a streaming component exists, so the pulse animates even during the pre-first-token wait.

The caret and its animation are their own `${indicator}` value, separate from the `${symbol}` label, so the `inputPrompt` template composes the two: `${symbol} ${indicator}` reads as `dsh <caret>`. Configurability lives at that template — a deployment reorders or drops either value, and omitting `${indicator}` opts out of the running indicator. The glyph set, the pulse, and the `dsh` label are fixed in code — not per-deployment fields — matching the fixed timing-bucket labels they mirror.

The built-in `${symbol}`/`${indicator}` updates ride the renders the TUI already drives on every state change that can move a value (`agent/status`, session events, the 100 ms running-status timer, async model-context resolution). A prompt value that changes on its own schedule — a plugin-owned `${custom}` fragment — instead redraws through the registry's coalesced change notification, which the renderer subscribes to directly rather than through a Cordis event ([registry](2026-07-24-configurable-tui-prompt-theme.md)).

## Alternatives considered

**Prepend the glyph before `dsh>` as its own `${status}` token.** Rejected: a leading token shifts the whole prompt — and the cursor — right by two columns whenever it appears, and collapses back when it clears. Replacing the caret keeps the cursor column fixed.

**A blinking glyph that appears and disappears.** Rejected: on/off blanking still moves nothing horizontally once the glyph owns the caret column, but the empty frames read as flicker. A brightness pulse animates continuously while the character stays put.

**A per-phase spinner animation** (rotating frames). Rejected: the four phases are already distinguished by their glyph shapes; swapping the character per frame would conflate "which phase" with "still working". The pulse animates intensity while the shape stays a stable phase signal, reusing the existing 100 ms status timer.

**A new phase state machine in the TUI.** Rejected: the header-timing machinery already replays the open step's active bucket from session events. Deriving the glyph from that bucket keeps one source of truth for "what phase is this step in".

## Consequences

The user gets a live, glanceable phase signal in the caret they are already watching, with no horizontal movement of the cursor or the prompt. The pulse costs terminal renders on every 100 ms tick for the whole running turn, not only while a streaming component is mounted. The glyph mapping and the pulse are fixed in code, not configurable, matching the fixed timing-bucket labels they mirror.
