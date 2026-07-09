# approval/ — approval family

The asking half of permission handling: one seam through which the harness puts a one-shot question — "may this specific action proceed?" — to whatever answerers a deployment composes, with a closed outcome vocabulary and a fail-closed default. The full design: [the approval-seam RFC](../../docs/rfc/proposed/feature/2026-07-06-approval-seam.md). All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `approval/` | The `ApprovalService` mechanism (waterfall dispatch, cancellation, audit events) + the vocabulary (`ApprovalRequest`, `ApprovalOutcome`, `ApprovalRequestId`) | `ctx.approval` |

Answerers live with their owners, not here: tests answer with inline scripted listeners, and the ACP bridge answerer is the staged first real one. Consumer today: [`core/tools`](../core/tools/) routes `tools/pre-execute`'s `ask` through the seam (degrading to deny when it is not mounted).
