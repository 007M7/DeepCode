/**
 * Scope-addressed conversation send, cancel, history, and retained-prompt orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from 'cordis'
import type { Context } from 'cordis'
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
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
    const uploaded = await this.serializeImages(images)
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
    const session = this.requireSessions().binding(sessionId)?.session
    if (session === undefined) return Promise.reject(new Error(`conversation.resolveImage: unknown session "${sessionId}"`))
    const pending = session.readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (typeof URL.createObjectURL !== 'function') {
          return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        }
        const bytes = Uint8Array.from(result.value.data)
        const url = URL.createObjectURL(new Blob([bytes.buffer], {
          type: result.value.attachment.mediaType,
        }))
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

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession('loadOlder').loadOlder()
  }

  /**
   * Copy browser-owned images into the current Session Intent before its
   * workspace/session materialization starts.
   * @param images - temporary files selected in the empty-state composer.
   */
  async prepareIntentImages(images: readonly File[]): Promise<void> {
    this.validateImages(images, [], true)
    const session = this.requireSessions().intent()
    if (session === undefined) throw new Error('conversation.prepareIntentImages: no active Session intent')
    session.updatePendingImages(await this.serializeImages(images))
  }

  /**
   * Update the scoped Session's retained pending prompt.
   * @param text - exact controlled-input value to retain.
   */
  updatePendingPrompt(text: string): void {
    this.scopedSession('updatePendingPrompt').updatePendingPrompt(text)
  }

  /** Retry the scoped Session's retained pending prompt. */
  retryPendingPrompt(): void {
    this.scopedSession('retryPendingPrompt').retryPendingPrompt()
  }

  /** Resolve the caller scope's Session or throw on root contexts. */
  private scopedSession(op: string): Session {
    const id = this.scopeId(op)
    const binding = this.requireSessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.${op}: session "${id}" resolved no binding`)
    return binding.session
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return id
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
    if (files.length === 0 && current.length === 0) return
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

  /** Convert browser files to the prompt wire's canonical base64 image parts. */
  private serializeImages(images: readonly File[]): Promise<Parameters<Session['updatePendingImages']>[0]> {
    return Promise.all(images.map(async file => ({
      type: 'image' as const,
      mediaType: imageMediaType(file.type),
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      ...(file.name === '' ? {} : { name: file.name }),
    })))
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
