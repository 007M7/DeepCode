# 003 — Fade-slide expanded content into place

- **Status**: DONE
- **Commit**: (repo has no commits yet — uncommitted working tree, 2026-07-18)
- **Severity**: MEDIUM
- **Category**: Missed opportunities
- **Estimated scope**: 1 file (styles.css), 1 keyframe + 3 selectors

## Problem

Expanding a trajectory row, a chat activity block, or a tree turn teleports its content into the layout — a jarring change on the most-used disclosure surfaces:

- `.traj-body` (trajectory expanded row) — inserted by re-render on toggle
- `.activity-body` (chat Thinking / Tool use `<details>`)
- `.tree-steps` (tree turn `<details>`)

## Target

One shared enter animation; exit stays instant (collapse must snap):

```css
@keyframes content-enter {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.traj-body,
.chat-activity[open] .activity-body,
.tree-turn[open] .tree-steps {
  animation: content-enter 160ms var(--ease-out);
}
```

Keyframes (not transitions) are correct here: each open is a fresh one-shot enter; re-opening restarting from zero is the intended semantic.

## Repo conventions to follow

- `--ease-out` token from plan 001 (depends on it).
- Place the keyframe near the existing `@keyframes traj-flash` block.

## Steps

1. styles.css: add the `content-enter` keyframe next to `traj-flash`.
2. styles.css: add the three-selector rule exactly as in Target.

## Boundaries

- Do NOT animate height (no interpolate-size tricks) — opacity+transform only.
- Do NOT animate collapse.
- Do NOT touch `.md-*`, `.spawn-list`, or inline feedback form styles.

## Verification

- **Feel check**: expand a trajectory row — the body settles downward-into-place in ~160ms; collapse is instant. Open a chat Tool use block — same. Expand-all in trajectory: bodies animate once, scrolling stays smooth (animation is per-element, one-shot).
- **Done when**: all three surfaces animate on open, none on close.
