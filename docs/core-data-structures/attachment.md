# Durable Image Attachments

English | [中文](attachment.zh.md)

The attachment seam separates binary image ownership from the session log. A producer gives validated encoded bytes to [`ctx.attachments`](../cordis-catalog/services.md#ctxattachments); the service publishes an immutable content-addressed reference only after the object is durable. Session events and model-visible `ImageBlock`s contain that reference and metadata, never a browser object URL, host temporary path, provider URL, or base64 payload.

Unsent browser drafts may stay in memory and native clients may stage them in operating-system temporary storage. Once the host accepts a user message, its images move below `<DSH_HOME>/attachments/v1` before the user event is appended. Structured model image output follows the same persist-before-event rule.

Source: [`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## Identity and verified metadata

`AttachmentId` is a branded opaque string. The local backend currently emits `sha256:<digest>`, but consumers must neither parse that representation nor derive a filesystem path from it.

```ts type-equiv
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

```ts type-equiv
/** Durable, serializable metadata for one immutable image object. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}
```

```ts type-equiv
/** Deployment-resolved limits shared by upload consumers and UI preflight. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  mediaTypes: readonly ImageMediaType[]
}
```

The reference records intrinsic dimensions and encoded length so clients can lay out history without decoding first, while every authoritative read still re-checks digest, media signature, dimensions, and metadata against the object.

## Commit and verified-read payloads

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against magic bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
```

`saveImage()` validates bytes and atomically commits one object before returning its reference. `readImage()` accepts a reference from an authorized session path and returns bytes only after integrity verification. The service is deliberately retention-neutral: resumed and forked sessions may share objects, so reference-aware garbage collection is deferred rather than tied to any one session's deletion.
