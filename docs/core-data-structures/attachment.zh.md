# 持久图片附件

[English](attachment.md) | 中文

附件服务边界将二进制图片的所有权与会话日志分离。生成方把经过校验的编码字节交给 [`ctx.attachments`](../cordis-catalog/services.md#ctxattachments)；只有对象完成持久化后，该服务才会发布不可变的内容寻址引用。会话事件和模型可见的 `ImageBlock` 包含该引用及其元数据，绝不包含浏览器对象 URL、宿主临时路径、提供方 URL 或 base64 数据。

未发送的浏览器草稿可以保留在内存中，原生客户端也可以将其暂存于操作系统临时存储。宿主接受用户消息后，会先把消息中的图片移到 `<DSH_HOME>/attachments/v1` 下，再追加用户事件。结构化模型图片输出遵循同样的先持久化、后追加事件规则。

来源：[`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## 标识与经过校验的元数据

`AttachmentId` 是带类型标记的不透明字符串。本地后端目前生成 `sha256:<digest>`，但消费方既不能解析这种表示，也不能据此派生文件系统路径。

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
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  mediaTypes: readonly ImageMediaType[]
}
```

引用记录固有尺寸和编码长度，使客户端无需先解码即可排布历史记录；每次权威读取仍会根据对象重新校验摘要、媒体签名、尺寸和元数据。

## 提交与校验读取的数据

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
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

`saveImage()` 校验字节并以原子方式提交一个对象，之后才返回其引用。`validateImage()` 执行相同的准入检查，但不持久化任何内容；批量调用方会在保存任何成员前通过它校验所有成员，因此校验拒绝不会留下部分对象。`readImage()` 接受来自已授权会话路径的引用，只在完整性校验通过后返回字节。该服务刻意不规定保留策略：恢复和 fork 后的会话可能共享对象，因此基于引用的垃圾回收会延期实现，而不是与任何一个会话的删除绑定。
