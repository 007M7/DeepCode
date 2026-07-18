# Animation plans

Written by the `improve-animations` audit (2026-07-18) against the uncommitted working tree.

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Add easing token, upgrade transitions](001-motion-foundation.md) | LOW (foundation) | DONE |
| 002 | [Inspector content slide-in](002-inspector-enter.md) | MEDIUM | DONE |
| 003 | [Fade-slide expanded content](003-details-enter.md) | MEDIUM | DONE |
| 004 | [Press feedback on pushbuttons](004-press-feedback.md) | LOW | DONE |
| 005 | [prefers-reduced-motion support](005-reduced-motion.md) | MEDIUM | DONE |

Execution order: 001 first (defines `--ease-out` used by all others), then 002–004 in any order, 005 last (its selectors target rules created by 002–004).

Explicit non-findings from the audit (do not "fix" these): instant view switching, instant hover states, the 1.4s flash pulse, instant collapse/close animations — all deliberate restraint for a crisp dashboard.
