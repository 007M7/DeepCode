# @deepseek-ai/dsh-spill-policy

The **tool-result spill policy**: a `tools/post-execute` transformer that keeps oversized plain-text tool results out of the model's context. When a final result exceeds `maxInlineBytes`, it saves the FULL text to a session-scoped spill file via [`ctx.spillFiles`](../spill) and replaces the model-facing result with a bounded head/tail preview plus the spill path — the model reads the complete result later with the existing `read` tool.

This plugin registers **no service** and owns no storage or preview mechanics: preview is [`@deepseek-ai/dsh-retention`](../../util/retention) (`TextRetainer`), storage is `ctx.spillFiles`. It only decides WHEN to spill and composes the notice.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxInlineBytes` | *(omitted)* | Model-facing context cap for a plain-text result, in UTF-8 bytes (a non-negative integer; validated at load). **Omitted disables the policy entirely** (the plugin registers nothing). When set, a larger result is spilled and replaced with a preview derived from the same budget (head/tail split). |

## Behavior

1. Let the tool run (delegates via `next()`, so it bounds whatever a downstream hook accepted).
2. Skip `read` (avoids a `read → spill file → read again` loop) and any non-`accept` decision (a `block`'s corrective feedback passes through).
3. Flatten the accepted content only when it is **plain text** (all `text` blocks); a result with any non-text block is left untouched.
4. If its UTF-8 size is `≤ maxInlineBytes`, leave it unchanged.
5. Otherwise save the full text and replace the result with a preview + this notice, sized so the whole replacement (preview + blank line + notice) stays within `maxInlineBytes` — the notice's byte cost is reserved out of the budget, so the preview shrinks to fit and the model-facing result never exceeds the cap:

   ```text
   <retained head/tail preview>

   (Omitted N bytes. Full formatted result saved to: /…/session-…/…-web_fetch.txt. Use read with offset/limit to inspect it.)
   ```

   When the notice alone fills the budget (a tiny cap or a long path) the preview is empty and only the notice is returned. If even that notice-only replacement is not smaller than the original result, the policy keeps the inline result — spilling would only add bytes.

**Best-effort:** no session owner, no `ctx.spillFiles` backend, or a `saveText` rejection ⇒ the policy logs a warning and returns the original result. A spill failure never turns a successful call into an `isError` or hides the inline result.

## Scope

The policy sees only the FINAL formatted tool result — not a tool's internal resource. If a provider already truncated (e.g. `web-fetch-local.maxBodyChars`), the spill file holds the full formatted result the tool returned, not the full original source. Provider/resource caps stay mandatory and separate. Tool-owned early spill (bash streams, subagent rollouts) is future work — see the [tool output spill RFC](../../../docs/rfc/implemented/architecture/2026-07-08-tool-output-spill-files.md).
