# 005 — prefers-reduced-motion support

- **Status**: DONE
- **Commit**: (repo has no commits yet — uncommitted working tree, 2026-07-18)
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 file (styles.css), 1 media query block

## Problem

styles.css has zero `prefers-reduced-motion` handling. Movement-based motion (toast slide, inspector slide-in from 002, content slide from 003, press scale from 004) plays regardless of the OS setting.

## Target

Reduced motion = drop position/scale changes, KEEP opacity feedback (comprehension aids stay):

```css
@media (prefers-reduced-motion: reduce) {
  .toast {
    transform: none;
    transition: opacity 200ms var(--ease-out);
  }
  .chat-split.inspector-open .inspector,
  .wf-split.inspector-open .inspector {
    transition: opacity 200ms var(--ease-out);
    @starting-style {
      transform: translateX(0);
    }
  }
  .traj-body,
  .chat-activity[open] .activity-body,
  .tree-turn[open] .tree-steps {
    animation: none;
  }
  .segmented button:active,
  .trajectory-toolbar button:active,
  .drawer-actions button:active,
  .row-tools button:active,
  .fb-send:active,
  .feedback-submit:active,
  .new-session-button:active,
  .activity-open-inspector:active {
    transform: none;
  }
  .flash {
    animation: none;
    box-shadow: 0 0 0 3px rgba(10, 100, 255, .45);
  }
}
```

Note `.flash` keeps a static highlight ring (the jump-target indicator is comprehension, not decoration) — it just stops pulsing. `.toast` keeps its opacity fade.

## Repo conventions to follow

- Depends on plans 001–004 (targets their rules). Place the block at the end of styles.css, before the responsive media queries.

## Steps

1. styles.css: add the media query block exactly as in Target.

## Boundaries

- Do NOT remove opacity transitions — reduced motion is fewer/gentler, not zero.
- Do NOT gate hover color changes (no movement involved).

## Verification

- **Feel check**: DevTools → Rendering → emulate `prefers-reduced-motion: reduce`. Toast fades without sliding; inspector fades in place; expanding rows appears instantly; jump-to still shows a static ring.
- **Done when**: with reduction on, nothing on screen translates or scales, but state feedback remains visible.
