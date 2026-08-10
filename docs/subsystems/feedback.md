# Message Feedback

English | [中文](feedback.zh.md)

[`@deepseek-ai/dsh-message-feedback`](../../packages/feedback/message-feedback) owns editable feedback for individual assistant messages. It is deliberately separate from the immutable Session-level `feedback/record` event: message feedback is a local storage-domain sidecar, not Session-log content or a projection, and it performs no telemetry handoff.

Source: [`packages/feedback/message-feedback/src/types.ts`](../../packages/feedback/message-feedback/src/types.ts)

## Data and concurrency

One Session sidecar row contains its header identity `{createdAt, cwd}` and feedback items keyed by `MessageId`. Each item carries a positive or negative rating, an optional note, Host-assigned `createdAt`/`updatedAt` timestamps, and its own opaque version. Versions are compared only for equality and only against the addressed message; callers do not order or synthesize them.

`put` is optimistic and retry-safe. An exact retry of the already stored desired value returns that item before a stale `ifVersion` is treated as a conflict. Deleting an already absent item also succeeds. A per-Session queue encloses inspection, read, conflict evaluation, and whole-row write, so these guarantees cover concurrent calls in one Host process.

## Target and lifecycle authority

`SessionPersistence.inspect()` supplies the target Session observation without publishing or resuming an Agent and without committing cold repair. A cold `listSnapshots()` preflight classifies definite absence; inspection failure for a catalogued Session propagates as infrastructure failure. `put` accepts only a non-empty, append-origin `assistant/message` with the requested `MessageId`; replacement-origin, usage-only empty, and non-assistant records are not feedback targets.

The stored `{createdAt, cwd}` identity must match the inspected header. A mismatch is treated as absence: `list` returns no items, while `put` may replace the stale row with one bound to the current header identity. Forks use a new Session identity and receive no sidecar copy even when their seed contains the same messages.

## Persistence and Remote contract

The service stores whole Session rows in the `message_feedback` storage domain through `ctx.storageDomain`. Before `put` commits a row that references a target message, a matching live target passes through the canonical `ctx.sessions.flush` checkpoint; a catalogued cold target is physically re-read from sequence zero through `SessionPersistence.readFrom`. The resulting observation is revalidated before the sidecar write, so the durable target log always precedes its sidecar commit. `maxNoteBytes` is required and bounds note text by UTF-8 bytes; the Web Host composition sets `8192`. The package publishes the Host `messageFeedback.list`, `messageFeedback.put`, and `messageFeedback.delete` unary Remote contract through `GatewayService` and `@Remote`; the generated Cordis surface below is the method-level authority.

## Boundaries and limitations

- The client Remote aggregate mount and UI consumer are separately owned and deferred.
- The mutation queue is process-local. Storage-domain has no cross-process conditional write, so multiple Host writers to one storage root have no compare-and-swap or lost-update guarantee.
- Session persistence has no durable deletion surface. The service does not treat `session/disposed` or `host/session-removed` as deletion and therefore performs no fake cascade; orphan sidecar rows may remain after out-of-band log removal.
- A request in the narrow interval after live detach but before the persistence catalog materializes the header can receive `session-not-found`; callers retry after retirement materialization.
- Header identity detects a reused id only when `{createdAt, cwd}` differs; a cloned log retaining the same header identity is indistinguishable by this contract.
- The Host contract records no authenticated actor or audit identity and therefore assumes a trusted caller boundary.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis surface

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` surface lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmessagefeedback--messagefeedbackservice"></a>

### `ctx.messageFeedback` — `MessageFeedbackService`

Storage-domain sidecar service. It inspects persisted Session history and never creates or resumes an Agent or Session.

```ts cordis-catalog
/**
 * Read feedback belonging to the current persisted Session lifecycle.
 * A stale row from a reused Session id is invisible.
 * @param request - Session identity to inspect and list.
 * @returns current immutable items or `session-not-found`.
 */
@Remote('list') async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>

/**
 * Create or replace feedback for one derived append-origin assistant
 * message. An exact desired-value retry returns the stored item before its
 * stale or `null` version is considered a conflict.
 * @param request - target, desired value, and observed item version.
 * @returns the committed item or an explicit business failure.
 */
@Remote('put') put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>

/**
 * Delete one feedback item. Absence is successful regardless of the
 * supplied version; an existing item requires an exact version match.
 * @param request - Session, message, and observed item version.
 * @returns the stable absent postcondition, or an explicit failure.
 */
@Remote('delete') delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
```

Source: [`packages/feedback/message-feedback/src/index.ts:150`](../../packages/feedback/message-feedback/src/index.ts)
<!-- END GENERATED cordis-surface -->
