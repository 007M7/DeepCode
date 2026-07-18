# 004 — Press feedback on pushbuttons

- **Status**: DONE
- **Commit**: (repo has no commits yet — uncommitted working tree, 2026-07-18)
- **Severity**: LOW
- **Category**: Physicality & origin
- **Estimated scope**: 1 file (styles.css), 1 rule

## Problem

No pressable element gives press feedback; clicks feel dead. Applies to true pushbuttons only — rows and list items must NOT scale (they're selection surfaces, not buttons).

## Target

```css
.segmented button:active,
.trajectory-toolbar button:active,
.drawer-actions button:active,
.row-tools button:active,
.fb-send:active,
.feedback-submit:active,
.new-session-button:active,
.activity-open-inspector:active {
  transform: scale(0.97);
}

.segmented button,
.trajectory-toolbar button,
.drawer-actions button,
.row-tools button,
.fb-send,
.feedback-submit,
.new-session-button {
  transition: transform 160ms var(--ease-out);
}
```

Subtle (0.97), transform-only, 160ms — inside the 100–160ms press-feedback budget on release.

## Repo conventions to follow

- `--ease-out` token from plan 001 (depends on it).

## Steps

1. styles.css: add both rules near the global `button` styles at the top of the file.

## Boundaries

- Do NOT add `:active` scaling to `.session-row`, `.traj-summary`, `.tree-step`, `.spawn-link`, `.wf-label-col`, `.wf-bar`, or chat summaries.
- Do NOT scale below 0.95.

## Verification

- **Feel check**: hold the Trajectory segmented button down — it compresses slightly; release — it springs back over ~160ms. Click a session row — no scaling.
- **Done when**: pushbuttons compress on press, selection surfaces don't.
