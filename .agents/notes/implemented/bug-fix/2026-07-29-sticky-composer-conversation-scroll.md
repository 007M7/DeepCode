# Agent Note: Fixed header, sticky composer inside the transcript scrollport

Status: implemented

English | [中文](2026-07-29-sticky-composer-conversation-scroll.zh.md)

## Problem

The active conversation column split scrolling: the chat (and trajectory) view owned `overflow-y: auto`, while the composer stack sat as a sibling below that scrollport. A wheel gesture over the stats line or input therefore hit a non-scrolling region and did nothing — the transcript only moved when the pointer was over the message list. Long drafts made it worse: the textarea is itself a scrollport, so wheel over the composer could be trapped there. The session header must occupy the top of the column as ordinary chrome (not `position: sticky` inside the scrollport), while the composer must stick to the bottom of the same scrollport as the transcript so wheel over the footer moves the flow.

## Decision

While a session exists, `ConversationRoot` always supplies a `wrapActiveBody` owner callback that wraps the view ring in a `data-conversation-scroll` body and places a `data-composer-seat` around the whole `'conversation.composer'` chain output (fallback + elected overlay siblings from `overlay: true`). Active CSS sticks that seat with `position: sticky; bottom: 0` so Question/Approval takeovers stay visible when the user is not pinned to the floor; hero CSS centers the fallback stack inside the scroll body. `ConversationSession` keeps a chrome-hidden header + body shell while blank so that tree seat does not change on the first send. The session header remains `flex: none` column chrome above the scrollport when visible. ChatView and Trajectory/Waterfall keep a local scroller only when mounted outside that host (unit tests); under the host they set `overflow: visible` and resolve bottom-follow / prepend anchoring through `closest('[data-conversation-scroll]')`.

Session stats live on `'conversation.composer.dock'` (above `'conversation.input.dock'`). The InputBar textarea, when inside the host, chains `wheel` with `{ passive: false }`: while the capped textarea can still scroll in that direction it keeps the native gesture; only at its own edge does it `preventDefault` and apply `deltaY` to the host.

## Alternatives considered

**Sticky header and sticky composer inside one column scrollport.** Rejected for the header: it must occupy the top as fixed layout chrome, not participate in the scrollport's sticky layer.

**Fixed flex-none composer below the scrollport with wheel forwarding.** Rejected: the product requires the composer to stick inside the transcript scrollport so the footer is part of that scroll hit-testing surface, not a sibling that only forwards deltas.

**Portal the composer into ChatView's scroller.** Rejected: the composer is shared across view tabs; the wrap target is the Session body owned by the resident shell.

**Keep StatsLine inside ChatView below the message column.** Rejected: outside the sticky composer it would scroll away while the input stayed pinned.

## Consequences

Wheel over the footer scrolls the transcript; the visible layout is a fixed header, scrolling transcript, and sticky bottom composer. Stats appear on every active view tab. Nested view scrollers under the host are suppressed so sticky Turn headers in Trajectory stick to the column host. Hero → active keeps the same textarea DOM node (assembled slash-flow snapshot) and the InputHub draft.
