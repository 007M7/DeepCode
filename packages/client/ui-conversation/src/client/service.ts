/**
 * ConversationService implementation: scope-addressed send/cancel and the
 * empty-state startSession chain. Contract: api-contracts v3 section 7.
 * Selection/draft state moved to the declared chat store (slot terminal
 * design §4); the view registry moved to the 'conversation.view' slot (slot
 * ledger owns registration, ordering, and disposal) — what remains is the
 * send/stop orchestration face.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with scopeOf (same mechanism as the host tool
 * registry). Mutable state lives in plain objects reached by one property
 * read — field assignment through the tracker's shadow proxy is off-limits,
 * as are `#` hard-private fields.
 */
import { Service } from 'cordis'
import type { Context } from 'cordis'
// Value import MUST use the /client subpath: only that specifier is in the
// bundle externals (CLIENT_EXTERNALS), so it resolves to the shared runtime
// module at load time. A bare-specifier value import gets INLINED as a second
// module instance whose private scope-tag Symbol never matches the one
// SessionsService tags contexts with — scopeOf then always returns undefined
// in the browser while unit tests (single-instance path resolution) stay green.
import { scopeOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { Session, SessionId, SessionsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ComposerAttachment } from './contract/slots.ts'

/** Opaque wrapper keeps browser `File` internals outside persisted store state. */
class BrowserDraftAttachment implements ComposerAttachment {
  readonly kind = 'image' as const
  readonly id: string
  readonly previewUrl: string
  readonly #file: File

  constructor(file: File) {
    this.id = crypto.randomUUID()
    this.previewUrl = URL.createObjectURL(file)
    this.#file = file
  }

  get file(): File {
    return this.#file
  }
}

interface ImageUrlEntry {
  readonly sessionId: SessionId
  readonly generation: number
  readonly pending: Promise<string>
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationService extends Service {
  private readonly draftAttachments = new Map<string, BrowserDraftAttachment>()
  private readonly imageUrls = new Map<string, ImageUrlEntry>()
  private readonly imageGenerations = new Map<SessionId, number>()
  private readonly createdImageUrls = new Set<string>()

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   */
  constructor(ctx: Context) {
    super(ctx, 'conversation')
    ctx.effect(() => () => {
      for (const url of this.createdImageUrls) URL.revokeObjectURL(url)
      this.createdImageUrls.clear()
      this.draftAttachments.clear()
      this.imageUrls.clear()
      this.imageGenerations.clear()
    }, 'conversation attachment URL cache')
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer surface); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block when non-empty.
   * @param mode - queue after the current turn, or steer into it.
   * @param images - browser-owned temporary images promoted by the host during this call.
   */
  async send(text: string, mode: 'queue' | 'steer', images: readonly File[] = []): Promise<void> {
    const session = this.scopedSession('send')
    this.validateImages(images, [])
    const uploaded = await Promise.all(images.map(async file => ({
      type: 'image' as const,
      mediaType: imageMediaType(file.type),
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      ...(file.name === '' ? {} : { name: file.name }),
    })))
    const content = [...uploaded, ...(text === '' ? [] : [{ type: 'text' as const, text }])]
    const result = await session.prompt(content, mode)
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Create runtime-only draft attachments and their object URLs.
   * @param files - browser-owned image files.
   * @param current - images already present in the same composer.
   * @param checkDefaultModel - whether to apply the host default-model capability before a session exists.
   * @returns ordered attachment descriptors whose ids may enter the chat store.
   */
  createDraftImages(
    files: readonly File[],
    current: readonly ComposerAttachment[] = [],
    checkDefaultModel = false,
  ): readonly ComposerAttachment[] {
    this.validateImages(files, current, checkDefaultModel)
    return files.map((file) => {
      const attachment = new BrowserDraftAttachment(file)
      this.draftAttachments.set(attachment.id, attachment)
      this.createdImageUrls.add(attachment.previewUrl)
      return attachment
    })
  }

  /**
   * Resolve ordered store ids to runtime-owned draft attachments.
   * @param ids - ordered ids from the chat store.
   * @returns attachments still available in this browser runtime.
   */
  draftImages(ids: readonly string[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment !== undefined) attachments.push(attachment)
    }
    return attachments
  }

  /**
   * Release one draft attachment preview.
   * @param id - draft-local attachment id.
   */
  releaseDraftImage(id: string): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined) return
    this.draftAttachments.delete(id)
    this.createdImageUrls.delete(attachment.previewUrl)
    revokePreview(attachment.previewUrl)
  }

  /**
   * Release sent draft attachment previews.
   * @param attachments - successfully submitted attachments.
   */
  releaseDraftImages(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftImage(attachment.id)
  }

  /**
   * Resolve and cache one session-authorized historical image as an object URL.
   * @param sessionId - session whose durable log grants the read.
   * @param attachment - immutable reference from that log.
   * @returns a browser URL for inline and original-size display.
   */
  resolveImage(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    const key = `${sessionId}:${attachment.attachmentId}`
    const cached = this.imageUrls.get(key)
    if (cached !== undefined) return cached.pending
    const generation = this.imageGenerations.get(sessionId) ?? 0
    const pending = this.requireSessions().manager.get(sessionId).readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (typeof URL.createObjectURL !== 'function') {
          return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        }
        const bytes = Uint8Array.from(result.value.data)
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
        if ((this.imageGenerations.get(sessionId) ?? 0) !== generation) {
          revokePreview(url)
          throw new Error('historical image scope was released before loading completed')
        }
        this.createdImageUrls.add(url)
        return url
      })
      .catch((error: unknown) => {
        if (this.imageUrls.get(key)?.generation === generation) this.imageUrls.delete(key)
        throw error
      })
    this.imageUrls.set(key, { sessionId, generation, pending })
    return pending
  }

  /**
   * Release every historical image URL owned by one rendered session.
   * @param sessionId - session whose rendered image scope is ending.
   */
  releaseSessionImages(sessionId: SessionId): void {
    this.imageGenerations.set(sessionId, (this.imageGenerations.get(sessionId) ?? 0) + 1)
    for (const [key, entry] of this.imageUrls) {
      if (entry.sessionId !== sessionId) continue
      this.imageUrls.delete(key)
      void entry.pending.then((url) => {
        if (!this.createdImageUrls.delete(url)) return
        revokePreview(url)
      }, () => {
        // A failed or generation-invalidated load owns no cached object URL.
      })
    }
  }

  /** Cancel the scoped session's in-flight turn (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Empty-state first-send chain (root-context method; does not read scope):
   * create the session, navigate to it, then send through the new scope.
   * The create → open ordering is safe: the manager merges the new summary
   * synchronously before create() resolves, so the list store is projected by
   * the time open() validates against it (manager notification batching is
   * microtask-based; SessionsService projects on the same flush that create
   * awaited through the RPC round trip).
   * @param opts - project directory, prompt text, images, and send mode.
   */
  async startSession(opts: {
    cwd?: string
    text: string
    images?: readonly File[]
    mode: 'queue' | 'steer'
  }): Promise<void> {
    const sessions = this.requireSessions()
    const id = await sessions.create(opts.cwd === undefined ? {} : { cwd: opts.cwd })
    // The manager notifier flushes per microtask; one await guarantees the
    // list-store projection landed before sessions.open validates against it.
    await Promise.resolve()
    sessions.open(id)
    const scoped = sessions.scope(id)
    if (scoped === undefined) throw new Error(`conversation.startSession: created session "${id}" resolved no scope`)
    // ctx.get, not scoped.conversation: property access walks the fiber
    // topology (a scope fiber never injects services), while get reads the
    // global store and still binds this service to the scoped ctx.
    const scopedConversation = scoped.get('conversation')
    if (scopedConversation === undefined) throw new Error('conversation.startSession: conversation service unavailable through the new scope')
    await scopedConversation.send(opts.text, opts.mode, opts.images ?? [])
  }

  /** Resolve the caller scope's Session or throw on root contexts. */
  private scopedSession(op: string): Session {
    const id = scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return this.requireSessions().manager.get(id)
  }

  private requireSessions(): SessionsService {
    // ctx.get instead of ctx.sessions: the typed Context merge is suspended
    // while the client/host `sessions` declaration collision awaits
    // arbitration (see the runtime package's Context merge note).
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }

  /** Apply host-advertised fast-path checks before any object URL or base64 allocation. */
  private validateImages(
    files: readonly File[],
    current: readonly ComposerAttachment[],
    checkDefaultModel = false,
  ): void {
    const description = this.requireSessions().hostDescription()
    const modalities = description?.activeModel?.inputModalities
    if (checkDefaultModel && modalities !== undefined && !modalities.includes('image')) {
      throw new Error('当前模型不支持图片输入')
    }
    const limits = description?.imageLimits
    const all = [...current.map(attachment => attachment.file), ...files]
    if (limits !== undefined && all.length > limits.maxImagesPerMessage) {
      throw new Error(`每条消息最多添加 ${limits.maxImagesPerMessage} 张图片`)
    }
    let totalBytes = 0
    for (const file of all) {
      const mediaType = imageMediaType(file.type)
      if (limits !== undefined && !limits.mediaTypes.includes(mediaType)) {
        throw new Error(`当前部署不支持 ${mediaType} 图片`)
      }
      if (limits !== undefined && file.size > limits.maxImageBytes) {
        throw new Error(`图片 ${file.name || '未命名图片'} 超过单张大小限制`)
      }
      totalBytes += file.size
    }
    if (limits !== undefined && totalBytes > limits.maxMessageImageBytes) {
      throw new Error('图片总大小超过单条消息限制')
    }
  }
}

function imageMediaType(value: string): ImageMediaType {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      throw new Error(`不支持的图片格式：${value || '未知格式'}`)
  }
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

function revokePreview(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
