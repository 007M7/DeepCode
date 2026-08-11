# @deepseek-ai/dsh-client-ui-attachment

English | [中文](README.zh.md)

Pure React attachment atoms (zero cordis): the composer draft-image rail (`AttachmentRail`), the chat-history image gallery (`MessageImage`/`ImageGallery`), and the original-image lightbox (`ImageLightbox`). Every string arrives through label props resolved by the owning plugin's own locale namespace, and nothing here reads application state; `@deepseek-ai/dsh-client-ui-conversation` is the current consumer, bridging its `conversation` dictionary through its `image-labels` module.

## Attachment rail

`AttachmentRail` renders pending draft images as fixed 64px thumbnails (16px radius) in one horizontally scrolling row whose scrollbar stays hidden. Overflow is announced by circular edge arrows instead: each pages one viewport (minus one card of context, floored at 200px) with smooth scrolling, and arrow visibility is recomputed from scroll geometry on scroll, item-count changes, and window resizes. A vertical wheel pans the rail horizontally with per-tick travel clamped to 60px, while trackpad horizontal pans keep native scrolling. A newly added item is revealed at the rail's end; removal keeps the scroll position. Each thumbnail opens its original through `onOpen` on a single click, and its remove control sits inside the card's top-right corner, hidden until the card is hovered or the control keyboard-focused; coarse-pointer (touch) surfaces show it permanently because they have no hover. The owner decides mounting and renders the rail only while items exist.

## Message images and the lightbox

`MessageImage` renders one durable history image bounded to 240px on its longer edge, loading a session-authorized URL through the owner's `ImageLoader`; a failed load renders an explicit retry control, and a settled load answers a single click by opening `ImageLightbox` (clicks during loading are ignored). `ImageGallery` wraps a message's images in one aligned flex group (`end` for user messages, `start` for assistant messages) and renders nothing for an empty list. `ImageLightbox` is a document-level modal preview that closes on Escape, a backdrop press, or its close control, and restores focus to its opener on unmount.

## Model Experience

None, as the package renders pure React atoms in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Images only** — non-image files have no rail card or history renderer yet; DeepSeek Chat-style file cards and upload-progress states wait until the composer accepts non-image attachments.
- **No zoom or download in the lightbox** — the preview renders the original at fit-to-viewport size only.
