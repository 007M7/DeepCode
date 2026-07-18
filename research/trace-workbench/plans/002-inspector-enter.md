# 002 — Slide the inspector's content in on open

- **Status**: DONE
- **Commit**: (repo has no commits yet — uncommitted working tree, 2026-07-18)
- **Severity**: MEDIUM
- **Category**: Missed opportunities
- **Estimated scope**: 1 file (styles.css), 1 rule + @starting-style

## Problem

The chat/waterfall inspector is a grid column toggled by `.inspector-open`; it appears via `display: none → flex` with zero motion — the panel teleports in with nothing explaining where it came from.

```css
/* styles.css — current */
.inspector {
  display: none;
  ...
}
.chat-split.inspector-open .inspector,
.wf-split.inspector-open .inspector {
  display: flex;
}
```

## Target

Animate the CONTENT entering (transform+opacity only — never animate the grid track, that's layout). Close stays instant (asymmetric timing: the system's response snaps).

```css
.chat-split.inspector-open .inspector,
.wf-split.inspector-open .inspector {
  display: flex;
  transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out);
  transform: translateX(0);
  opacity: 1;
  @starting-style {
    transform: translateX(16px);
    opacity: 0;
  }
}
```

(Nested `@starting-style` is supported in Chrome 117+; this app targets local Chrome.)

## Repo conventions to follow

- `--ease-out` token from plan 001 (depends on it).

## Steps

1. styles.css: extend the `.chat-split.inspector-open .inspector, .wf-split.inspector-open .inspector` rule with the transition, resting transform/opacity, and the nested `@starting-style` block exactly as in Target.

## Boundaries

- Do NOT animate `grid-template-columns`, width, or the divider.
- Do NOT add a close animation.

## Verification

- **Feel check**: click a chat message — the panel's content slides ~16px leftward while fading in, settling fast. Click Close — it disappears instantly. Rapidly open/close: no restart-from-zero flicker (transitions retarget).
- **Done when**: open animates, close is instant, no layout properties in the transition list.
