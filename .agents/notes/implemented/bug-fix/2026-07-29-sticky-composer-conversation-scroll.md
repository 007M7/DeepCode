# Agent Note: Fixed header, sticky composer inside the transcript scrollport

Status: implemented

English | [中文](2026-07-29-sticky-composer-conversation-scroll.zh.md)

## Problem

The active conversation column split scrolling: the chat (and trajectory) view owned `overflow-y: auto`, while the composer stack sat as a sibling below that scrollport. A wheel gesture over the stats line or input therefore hit a non-scrolling region and did nothing — the transcript only moved when the pointer was over the message list. Long drafts made it worse: the textarea is itself a scrollport, so wheel over the composer could be trapped there. The session header must occupy the top of the column as ordinary chrome (not `position: sticky` inside the scrollport), while the composer must stick to the bottom of the same scrollport as the transcript so wheel over the footer moves the flow.

## Decision

While a session exists, `ConversationRoot` always supplies a `wrapActiveBody` owner callback that wraps the view ring in a `data-conversation-scroll` body and places a `data-composer-seat` around the whole `'conversation.composer'` chain output (fallback + elected overlay siblings from `overlay: true`). Active CSS sticks that seat with `position: sticky; bottom: 0` so Question/Approval takeovers stay visible when the user is not pinned to the floor; hero CSS centers the fallback stack inside the scroll body. `ConversationSession` keeps a chrome-hidden header + body shell while blank so that tree seat does not change on the first send. The session header remains `flex: none` column chrome above the scrollport when visible. ChatView and Trajectory/Waterfall keep a local scroller only when mounted outside that host (unit tests); under the host they set `overflow: visible` and resolve bottom-follow / prepend anchoring through `closest('[data-conversation-scroll]')`.

Session stats live on `'conversation.composer.dock'` (above `'conversation.input.dock'`). The InputBar textarea, when inside the host, chains `wheel` with `{ passive: false }`: while the capped textarea can still scroll in that direction it keeps the native gesture; only at its own edge does it `preventDefault` and apply `deltaY` to the host.

Chat history prepend follows reader intent through stable rendered node/call identities rather than whole-scrollport height deltas. `ChatView` records the first visible `data-chat-anchor-key` and its top relative to the scrollport when paging starts, reselects the currently visible stable anchor after every reader scroll while the request is in flight, and compensates by that row's post-prepend rectangle delta. Reaching the bottom or appending the reader's own message cancels the paging anchor, so a late page cannot pull the view away from the newest content. Bottom follow is reader-owned intent, distinct from instantaneous geometry: raw scroll events never change ownership because programmatic writes, browser clamping or anchoring, and reader movement share the same event shape. `ChatView` arms a reader gesture from wheel/trackpad input that reaches the host, direct pointer or touch scrolling, native-scrollport pointer input, and vertical or focus-navigation keys; a nested overflow owner that can consume the direction does not arm the transcript. Wheel handling remains passive and takes its pre-input baseline from the last main-thread-delivered or programmatically written `scrollTop`, because Chromium may advance compositor geometry before delivering a passive wheel event. Only host movement during that gesture may transition between following and reading, and two idle animation frames end it; a new tail floor excludes its forced clamp from reader movement, and reading mode can reclaim follow only on reader movement toward the floor. A non-reader scroll drift re-pins while following and only refreshes the semantic saved position while reading. Semantic history restore and prepend correction cancel any active reader gesture before applying and saving their explicit ownership state. ChatView's single `ResizeObserver` owns bottom-follow decisions for column and sticky-composer height changes: it follows streaming, tool disclosure, and draft resize only while bottom ownership remains pinned and no reader gesture is active, without a second per-chunk scroll write.

## Alternatives considered

**Sticky header and sticky composer inside one column scrollport.** Rejected for the header: it must occupy the top as fixed layout chrome, not participate in the scrollport's sticky layer.

**Fixed flex-none composer below the scrollport with wheel forwarding.** Rejected: the product requires the composer to stick inside the transcript scrollport so the footer is part of that scroll hit-testing surface, not a sibling that only forwards deltas.

**Portal the composer into ChatView's scroller.** Rejected: the composer is shared across view tabs; the wrap target is the Session body owned by the resident shell.

**Keep StatsLine inside ChatView below the message column.** Rejected: outside the sticky composer it would scroll away while the input stayed pinned.

**Ignore or target-match the next scroll event after a programmatic bottom write.** Rejected: no-op writes may emit no event, repeated writes may coalesce, and stream finalization can shrink-clamp then regrow the scrollport before one delayed event reports a position different from the last target. That event is indistinguishable from reader movement without input provenance.

## Consequences

Wheel over the footer scrolls the transcript; the visible layout is a fixed header, scrolling transcript, and sticky bottom composer. Stats appear on every active view tab. Nested view scrollers under the host are suppressed so sticky Turn headers in Trajectory stick to the column host. Concurrent history, streaming, tool expansion, and composer reflow preserve the reader's newer scroll decision; outside an active reader gesture, delayed programmatic scroll events cannot change follow ownership. Hero → active keeps the same textarea DOM node (assembled slash-flow snapshot) and the InputHub draft.
