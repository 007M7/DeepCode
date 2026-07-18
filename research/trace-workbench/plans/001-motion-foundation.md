# 001 — Add easing token and upgrade existing transitions

- **Status**: DONE
- **Commit**: (repo has no commits yet — uncommitted working tree, 2026-07-18)
- **Severity**: LOW (foundation for 002–005)
- **Category**: Easing & duration / Cohesion & tokens
- **Estimated scope**: 1 file (styles.css), ~4 small edits

## Problem

No shared easing tokens exist; entrances use weak built-in `ease`:

```css
/* styles.css — current */
.toast {
  transition: opacity .18s ease, transform .18s ease;
}
.main-pane {
  transition: opacity .15s ease;
}
```

Built-in `ease` is too weak for deliberate motion; the toast enter feels mushy.

## Target

```css
:root {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1); /* strong ease-out for UI */
}
.toast {
  transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out);
}
.main-pane {
  transition: opacity 150ms var(--ease-out);
}
```

Keep `.pane-divider::after { transition: background .12s ease }` unchanged — hover/color change correctly uses `ease`.

## Repo conventions to follow

- All custom properties live in the single `:root` block at the top of styles.css (e.g. `--blue: #0a64ff;`); add `--ease-out` there.

## Steps

1. styles.css `:root`: add `--ease-out: cubic-bezier(0.23, 1, 0.32, 1);`.
2. styles.css `.toast`: replace transition with `opacity 200ms var(--ease-out), transform 200ms var(--ease-out)`.
3. styles.css `.main-pane`: replace transition with `opacity 150ms var(--ease-out)`.

## Boundaries

- Do NOT touch app.js or index.html.
- Do NOT change the `.pane-divider` or `.tree-turn-head::before` transitions.

## Verification

- **Mechanical**: reload http://127.0.0.1:5173/ — no console errors.
- **Feel check**: trigger a toast (submit an annotation); it should decelerate crisply into place instead of easing symmetrically. Switch sessions; the loading fade should feel unchanged or slightly snappier.
- **Done when**: token exists and both rules reference it.
