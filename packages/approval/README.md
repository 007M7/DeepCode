# approval/ — approval family

The asking half of permission handling: one seam through which the harness puts a one-shot question — "may this specific action proceed?" — to whatever answerers a deployment composes, with a closed outcome vocabulary and a fail-closed default. The full design: [the approval-seam RFC](../../docs/rfc/implemented/feature/2026-07-06-approval-seam.md). All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `approval/` | The `ApprovalService` mechanism (waterfall dispatch, cancellation, audit events) + the vocabulary (`ApprovalRequest`, `ApprovalOutcome`, `ApprovalRequestId`) + the per-session policy tier (`ApprovalPolicy` `'ask'`/`'never'`, the `'approval/policy'` event fold, the prepend gate — [sandbox RFC § Per-session mode switching](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)) | `ctx.approval` |

Answerers live with their owners, not here: the ACP bridge ([`ui/acp`](../ui/acp/)) answers for the editor sessions it owns (and switches each session's policy over ACP config options); tests answer with inline scripted listeners. Consumers today: [`core/tools`](../core/tools/) routes `tools/pre-execute`'s `ask` through the seam (degrading to deny when it is not mounted), and the bash tool's sandbox escalation gate ([`bash/tool-bash`](../bash/tool-bash/), [sandbox RFC § Escalation](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)).
