# Agent Note: Task Surface for structured session interaction

Status: proposed

English | [中文](2026-08-04-task-surface.zh.md)

## Problem

Some tasks are awkward to finish through alternating prose messages. Comparing several options, reordering a plan, reviewing a table, or filling a small set of related fields all work better as one structured interaction. Today an agent can describe such an interaction, but it cannot ask the Web client to render one without adding a permanent product component or generating executable Client Plugin code.

Those two workarounds put ownership in the wrong place. Product-specific components require a new trigger and release for every task shape. Generated code has far more authority and lifecycle cost than a one-turn form needs. It also makes the presentation, rather than the user's conclusion, the durable artifact.

The missing contract is a bounded, replayable description of a temporary UI that belongs to one Session and one tool occurrence. The product should own validation, placement, interaction mechanics, and submission. The agent should own the task-specific copy, data, and choice of supported components.

## Proposal

Add **Task Surface**, a versioned declarative model rendered by a normal Web Client Plugin. One stable model-facing tool, `show_task_surface`, publishes the model. A successful call ends the current turn. The user edits and submits the rendered panel; the Host records the submission as one ordinary visible user message and starts the next turn.

Task Surface is the default structured-UI path when all of the following hold:

- the interaction belongs to the current Session and current task;
- its behavior fits the declared component set;
- it needs no background execution or new runtime authority; and
- the useful durable result is the user's submitted conclusion, not the panel itself.

This is one trigger, not a family of product heuristics. The agent calls `show_task_surface` explicitly. A user may ask the agent to use a Task Surface in ordinary language. Products do not inspect tool names or task topics to open bespoke panels, and repeated use does not automatically turn a Task Surface into a Plugin.

Short blocking questions remain with [`ask_user_question`](../../implemented/feature/2026-07-29-ask-question-web-presentation.md). Plain explanation remains chat. Cross-Session navigation, background behavior, new services, or durable custom UI belongs to the Generated Client Plugin workflow.

## Declarative model

`TaskSurfaceModelV1` is JSON. It contains content blocks, input fields, and one submit label; it contains no code, callbacks, selectors, HTML, CSS, URLs to executable assets, or expression language. This type is unrelated to core Session's existing `SurfaceManager`/`SurfaceOp` message-reduction types; Task Surface is a product interaction protocol.

```ts ignore-check
interface TaskSurfaceModelV1 {
  version: 1
  title: string
  description?: string
  sections: TaskSurfaceSection[]
  fields?: TaskSurfaceField[]
  submit: { label: string }
}

interface TaskSurfaceSection {
  id: string
  title?: string
  layout?: 'stack' | 'grid'
  columns?: 2 | 3
  blocks: TaskSurfaceBlock[]
}

type TaskSurfaceBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'metrics'; items: { label: string; value: string; detail?: string }[] }
  | { kind: 'table'; columns: { id: string; label: string }[]; rows: Record<string, string | number | boolean | null>[] }
  | { kind: 'diff'; path?: string; before: string | null; after: string; language?: string }
  | { kind: 'notice'; tone: 'neutral' | 'info' | 'warning'; text: string }

type TaskSurfaceField =
  | { kind: 'text'; id: string; label: string; multiline?: boolean; required?: boolean; initial?: string }
  | { kind: 'choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string }
  | { kind: 'multi-choice'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }
  | { kind: 'toggle'; id: string; label: string; initial?: boolean }
  | { kind: 'order'; id: string; label: string; options: TaskSurfaceOption[]; initial?: string[] }

interface TaskSurfaceOption { id: string; label: string; detail?: string }
```

The renderer controls typography, spacing, responsive layout, focus order, keyboard behavior, and theme tokens. `grid` is a layout hint: it collapses when the available width cannot support the requested columns. Markdown uses the product's supported Markdown subset. Unknown versions or union arms use the generic tool-result fallback instead of partial interpretation.

Version 1 deliberately omits conditional fields, client-side data fetching, charts, file uploads, and arbitrary event handlers. A new block or field kind is a protocol change with a parser, renderer, accessibility behavior, fallback, and replay fixture in the same change.

Limits are schema-backed configuration on the Task Surface service. The initial defaults are 64 KiB for the normalized model, 64 blocks, 32 fields, 200 table rows, and 32 KiB for a submission. IDs are unique within the model; field values must match their declarations; unknown fields are rejected. The limits bound log, DOM, and prompt costs without changing the protocol.

## Tool and presentation contract

`show_task_surface` accepts `{ model: TaskSurfaceModelV1 }`. The Host parses and normalizes the complete model, rejects the call when that Session already has an open Task Surface, mints `surfaceId`, and returns canonical `{ surfaceId, model }` with the normalized model. `presentationMeta` persists `value.model`, so the projector and executor cannot disagree about normalization. The Native result names the Surface and explains that an ordinary message bypasses it when the client cannot render the panel. The tool then calls `exec.concludeTurn()` so the agent does not continue past the requested human checkpoint.

The tool definition sets `exclusive: true`, and the tool is composed only in Web profiles that mount both the Host service and Web renderer. Version 1 supports `native` and `both` tool modes; a `code`-only profile does not advertise it because Code Mode dispatch is nested and cannot carry its presentation metadata to the outer result.

The canonical value is execution-local under the [canonical tool output contract](../../implemented/architecture/2026-07-20-canonical-tool-output-contract.md). Replay therefore uses `output.presentationMeta(args, value)` to persist this tagged payload with `tool/result.meta`:

```ts ignore-check
interface TaskSurfacePresentationMeta {
  kind: 'dsh/task-surface'
  version: 1
  surfaceId: string
  model: TaskSurfaceModelV1
}
```

The tool keeps a generic [render intent](../../implemented/architecture/2026-07-02-tool-render-intent-union.md). The keyed Web row reads the tagged metadata already retained on `ToolResultNode`; no new render-intent arm or presentation registry is required. Clients without Task Surface support render the ordinary result content.

The Web plugin statically registers one keyed `conversation.chat.toolview` entry for `show_task_surface`, following the [toolview](../../implemented/architecture/2026-07-23-toolview-dissolution.md) and [slot registration](../../implemented/architecture/2026-07-22-slot-type-chain-implementation.md) contracts. The row renders a compact summary when settled and expands the declarative panel inline. The model does not choose a conversation tab, details column, modal, pixel position, or z-index. A later placement change remains a renderer decision and does not alter logged models.

## Submission contract

The Task Surface domain exposes three operations through the Host transport. `submit` is the only one that admits a user message:

```ts ignore-check
type TaskSurfaceSubmissionId = string & { readonly __brand: 'TaskSurfaceSubmissionId' }
type TaskSurfaceDismissalId = string & { readonly __brand: 'TaskSurfaceDismissalId' }

interface TaskSurfaceService {
  getActive(input: { sessionId: SessionId; surfaceId: string }): Promise<GetActiveTaskSurfaceResult>
  submit(input: SubmitTaskSurfaceRequest): Promise<SubmitTaskSurfaceResult>
  dismiss(input: DismissTaskSurfaceRequest): Promise<DismissTaskSurfaceResult>
}

interface SubmitTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: string
  submissionId: TaskSurfaceSubmissionId
  values: Record<string, JsonValue>
  note?: string
}

type SubmitTaskSurfaceResult =
  | { accepted: true; messageId: MessageId }
  | { accepted: false; reason: 'not-open' | 'stale' | 'invalid-submission' }

type GetActiveTaskSurfaceResult =
  | { active: true; callId: CallId; surfaceId: string; model: TaskSurfaceModelV1 }
  | { active: false; reason: 'not-open' }

interface DismissTaskSurfaceRequest {
  sessionId: SessionId
  surfaceId: string
  dismissalId: TaskSurfaceDismissalId
}

type DismissTaskSurfaceResult =
  | { dismissed: true; eventSeq: number }
  | { dismissed: false; reason: 'not-open' | 'stale' }
```

The Host resolves the exact successful `show_task_surface` occurrence, revalidates the submitted values against its persisted model, and admits the response through the normal Session queue. The response becomes a user-role message with a merge-extensible source:

```ts ignore-check
interface TaskSurfaceCorrelation {
  version: 1
  submissionId: TaskSurfaceSubmissionId
  callId: CallId
  surfaceId: string
  values: Record<string, JsonValue>
}

interface TaskSurfaceUserMessageSource {
  kind: 'user'
  rpcId: RpcId
  taskSurface: TaskSurfaceCorrelation
}
```

The browser-safe domain package owns `TaskSurfaceCorrelation` and its branded `submissionId`. ApiProxy owns the transport augmentation that combines it with `rpcId`. Keeping `kind: 'user'` preserves the ordinary user bubble and prompt semantics while the extra field provides durable correlation. The message content is a product-formatted readable summary: panel title, labels and submitted values, plus the optional note. The model receives that same text. The structured source is not a second hidden instruction.

The product shell owns collapse and dismiss. Collapse is local view state and sends nothing. `taskSurface.dismiss({ sessionId, surfaceId, dismissalId })` appends one `task-surface/dismissed` Session event and does not start a turn; the exact event closes the projection and updates the transcript row. Retries reuse `dismissalId` and return the original result without appending another event.

Submission is transactional at the client boundary. The panel disables submit while admission is in flight and clears the persisted draft only after the matching user message becomes durable. A rejection keeps the values editable and shows the returned reason. Double clicks and transport retries reuse `submissionId`; the Host admits one user message for one accepted Surface.

There is a short interval between queue admission and the durable `user/message`. The generic queued-message DTO therefore retains `Message.source`. A queued message with matching Task Surface correlation keeps the panel disabled; if that queue item is discarded, the pending state clears and the draft becomes editable again. The Host holds a process-local single-flight claim for the same interval, then releases it on commit, rejection, or discard. The queue is coordination state, not a second durable lifecycle record.

## Lifecycle and recovery

The Session log is the authority. A small `taskSurface` unit in the existing [Session projection system](../architecture/2026-07-27-session-projection-and-command-log.md) folds successful surface result metadata and later user-message sources into this state:

```ts ignore-check
interface TaskSurfaceProjection {
  active: { callId: CallId; surfaceId: string } | null
}
```

One Session has at most one open Task Surface. A successful result opens it. A matching Task Surface user message or dismissal event closes it. A later ordinary user message also closes it as an explicit bypass; another `show_task_surface` call fails until one of those events closes the active occurrence. Rewind and fork derive their active occurrence by folding the resulting log; no separate Surface database participates.

The full model remains on its `tool/result.meta`; the projection carries only the active identity. When that result is outside the loaded history window, `taskSurface.getActive({ sessionId, surfaceId })` reads the exact occurrence from the Session log and returns `{ callId, surfaceId, model }` after revalidating the metadata. A missing or closed occurrence returns `not-open`. Refresh and reconnect therefore do not depend on the active result fitting in the history tail and do not duplicate the model into every projection baseline.

The Web plugin keeps unsubmitted values in a bounded, per-Session persisted slot store keyed by `surfaceId`; they never enter the Session log, prompt, or long-term memory. Submitted values live in the accepted user message, so losing a browser draft cannot erase a conclusion.

## Package boundaries and dependencies

The capability is split where ownership changes:

| Package | Responsibility |
|---|---|
| `packages/task-surface/task-surface` | Browser-safe model/types and correlation, parser, limits, submission validator/formatter, Session event extension, projection unit, and Host service contract |
| `packages/task-surface/tool-task-surface` | `show_task_surface`, canonical output, presentation metadata, generic render intent, active-Surface check, and `concludeTurn()` behavior |
| `packages/client/ui-task-surface` | Static keyed tool row, declarative Web renderer, per-Session draft store, and submit client |
| `packages/host/apiproxy` | Typed active-read/submit/dismiss transport, user-source augmentation, and queued-source carriage; delegates validation and admission to the Task Surface service |

The implementation depends on the existing message log, canonical tool output, tagged render intents, Session projection, per-Session declared slot stores, and slot lifecycle. It does not depend on runtime Client Plugin creation. The generated Client Plugin workflow may use Task Surface to present a review form, but neither protocol owns or activates the other.

## Delivery stages

1. Land the model/parser, projection unit, `show_task_surface`, presentation metadata, static Web row, and generic fallback with read-only blocks.
2. Add fields, persisted drafts, Host-validated submit/dismiss, queued-source carriage, and visible user-message admission.
3. Add only component kinds justified by real tasks and two consumers or a clear generic fallback. A separate explicit user action may start the generated Plugin authoring workflow, but it creates a candidate; it never promotes code directly.

## Alternatives considered

**Add product-specific triggers and panels.** Rejected because every new task shape would couple agent behavior to a shipped product component. Product code should define one admitted component vocabulary and placement policy; the agent chooses among it explicitly.

**Render arbitrary HTML, CSS, or JavaScript from the tool call.** Rejected because it turns a temporary interaction into executable Client Plugin code without the build, preview, evaluation, approval, or rollback lifecycle that code requires.

**Extend `userInteraction.ask()` with a large form.** Rejected for this contract. `ask()` is a blocking request/response operation used when a running tool cannot continue without a short answer. A Task Surface ends the turn, may remain open across refreshes, and submits its result as the next visible user turn.

**Register one dynamic `conversation.view` per call.** Rejected because the view ledger is global while its render scope is per Session, and because transient task identity would become registration identity. One static keyed toolview keeps occurrence data in the logged call where it belongs.

**Keep the model only in the canonical tool value.** Rejected because canonical values are not persisted. Replay requires the normalized model in `presentationMeta`.

**Store the panel in long-term memory.** Rejected because layout and draft state are not the reusable fact. Memory may retain the submitted user conclusion under existing memory policy.

## Acceptance criteria

- A real model in `native` or `both` mode can call one stable `show_task_surface` schema, the call ends its turn, and a capable Web client renders the same normalized model live and after replay; `code`-only mode does not advertise it.
- Submitting produces exactly one visible user message per `submissionId`, starts the next turn through normal queue admission, and retains exact occurrence correlation while keeping `source.kind: 'user'`; dismissing records one log event and starts no turn.
- Refresh, reconnect, Session switching, fork, and rewind produce the lifecycle state implied by the log; `getActive` recovers a model outside the history tail, and no panel leaks across Sessions.
- Unsupported versions, malformed metadata, and absent client capability fall back to readable tool-result content with the ordinary-message bypass; nested calls and calls made while another Surface is active fail without opening a Surface.
- The parser enforces IDs, union shapes, field values, and configured byte/count limits before the panel becomes actionable.
- Keyboard-only operation, focus restoration, accessible names, narrow layouts, both themes, and zh/en product chrome are covered by component tests.
- Keyless browser composition covers show, edit, retry after rejected admission, queued/discarded submission, durable submit, dismiss, refresh recovery, and double-submit idempotency.
- Prefix snapshots show one stable tool definition regardless of the task-specific model; only the call arguments and later user conclusion vary.
- Unloading the Web plugin disposes its row and draft stores through the owning Fiber without changing the durable transcript.

## Risks

The first component set may be either too small for useful tasks or broad enough to become a weak application framework. Usage evidence should decide additions; v1 has no expression language or network behavior.

Large tables and Markdown can still create expensive DOM even inside byte limits. The renderer must virtualize or truncate where needed while preserving a readable fallback and explicit counts.

A product-formatted submission can become verbose when many fields are filled. The formatter needs a deterministic compact form and must preserve every submitted value without repeating the complete display model.

Browser-local draft persistence can retain sensitive unsubmitted text. The store needs the stated byte bound, per-Session keys, explicit clearing after acceptance, and the same storage posture as the existing conversation draft.
