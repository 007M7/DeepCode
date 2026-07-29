# Agent Note: `/feedback` command

Status: implemented

English | [中文](2026-07-28-feedback-command.zh.md)

## Problem

A user who notices something wrong mid-session has nowhere to put that observation. Telling the model wastes a turn, changes the conversation the user was having, and buries the remark in derived history where no later reader can find it. Writing it outside the session loses the context that makes it meaningful — which session, at which point, against which work.

The capture surface has to be usable at the moment of annoyance, which rules out anything requiring the user to leave the TUI, and it must not perturb the run in progress: no model tokens, no turn of work, no change to the request the user is waiting on.

## Decision

`@deepseek-ai/dsh-command-feedback` in `packages/feedback/command-feedback/` registers one global `feedback` command over `ctx.commands`. `/feedback <text>` acknowledges; bare or whitespace-only input returns a direct usage error. The handler is synchronous, injects only `commands`, and has no configuration.

The plugin appends **no session event of its own**. `dsh-commands` already writes a `command/run` / `command/done` pair for every dispatched command, carrying the command name, the verbatim unparsed suffix, the invocation source, and the settled outcome. Those records are log-only and non-surface, so the feedback lands in the session log and stays invisible to the model without this package contributing anything to the log format. The appends start persistence's ordinary eager drain; nothing forces a flush, so the acknowledgement reports that the entry is recorded in the log rather than already on disk.

Capture is deliberately inert: nothing in this repository reads those records back.

### Why no dedicated `session/feedback` event

An earlier iteration declared one. It was removed because it duplicated a record the registry already writes: both would carry the same text, appended microseconds apart, and a consumer would have to decide which is authoritative. Selecting `command/run` records by command name is enough to find feedback, and it keeps this package free of the session event format entirely — no `SessionEventMap` merge, no invariant relation, no persistence catalog entry.

The cost is that the recorded text is the raw suffix including its leading separator whitespace, and that feedback is distinguished from other commands only by name. Both are read-time concerns for a consumer that does not yet exist; neither justifies a second durable record now.

### Why the model never sees it

Feedback is about the session, not input to it. Injecting it as a user message would change the next model request, contradicting the requirement that recording not perturb the run, and would make the remark part of the conversation it comments on. `command/run` and `command/done` are absent from `SurfaceEventType`, so they cannot acquire a `surfaceOp` or enter derived history even by mistake.

### Verbatim text

Nothing is parsed. `/feedback /plan felt slow` records that literal text; the leading `/plan` is content, not a nested command. The handler trims only to decide whether any text was supplied. Control-word grammar of the kind `/goal` uses would make the corresponding literal feedback impossible to express, which is the opposite of what a capture surface is for.

### A new group

`packages/feedback/` is a new group because no existing one owns this. `goal/` is objective state, `session-title/` is titles, `core/` is the product spine. The group holds one package; a consumer would join it rather than forcing this one to grow.

## Alternatives considered

**Declare a dedicated `session/feedback` log-only event.** Implemented first, then removed. It gave feedback a first-class queryable type with pre-trimmed text, but duplicated the registry's record, added a `SessionEventMap` member and persistence-catalog entry to the frozen log format, and created two records of one act with no rule for which wins.

**Inject feedback as a user message via `agent.inject()`.** Needs no new event type and reuses the path `/goal` mutations take. Rejected: it makes the feedback model-visible, so it enters the next request, changes the run being commented on, and consumes tokens — contradicting all three parts of the no-perturbation requirement.

**Make `/feedback` a true no-op that records nothing.** The most literal reading of "does not do anything". Rejected because it makes the command pointless: the stated requirement was that the remark reach the session log.

**Register the command inside an existing package** such as `packages/ui/commands`. Avoids a new group and its README pair. Rejected: `ctx.commands` is the registry, not a home for arbitrary command implementations, and the requester asked for a standalone package.

**Parse structure out of the text** (category prefixes, severity markers). Rejected as speculative: no consumer exists to use the structure, and any control-word grammar makes the corresponding literal feedback unrecordable. Verbatim text is the widest surface a future consumer can narrow; a parsed one cannot be widened after the fact.

**Add a model-facing tool instead of a slash command.** Rejected: feedback is a direct human observation. Routing it through the model spends a turn, lets the model paraphrase the user's words, and makes the record contingent on the model choosing to call the tool.

## Consequences

The TUI mounts the command unconditionally — no configuration, no dependency on the goal stack. The headless CLI, ACP, and JSON-RPC apps do not consume `ctx.commands`, so `/feedback` is unavailable there.

This package is now small enough that its whole contract is the command definition plus one validation branch. It owns no session event, so it needs no invariant relation and cannot affect replay, forking, or crash recovery.

Deferred: no consumer; no structured fields; no amend or withdraw, since the log is append-only and this package adds no tombstone; the recorded text is untrimmed, so a consumer trims at read time; and no explicit durability barrier, so an entry recorded immediately before a crash can be lost with any other unflushed tail.

No snapshot accompanies this change. AGENTS.md asks for a keyless snapshot through a runnable example for product-user-visible behavior; this was skipped at the requester's explicit direction. The package tests plus a real Loader composition test over a `cordis.yml` are the whole of the evidence, alongside interactive verification in the assembled TUI.
