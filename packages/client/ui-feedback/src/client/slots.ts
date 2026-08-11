/**
 * The feedback entry's injected face. The target
 * 'conversation.chat.assistant-actions' slot is declared and typed by
 * ui-conversation; this package only contributes the entry, so no SlotMap
 * merge lives here. Live per-message state arrives through the `feedback`
 * hook (the framework standard kit binds it into `useFeedback`); inject
 * carries the two mutation verbs plus the lazy loader.
 * @module @deepseek-ai/dsh-client-ui-feedback/client/slots
 */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { MessageFeedbackRating } from '@deepseek-ai/dsh-message-feedback/types'
// Type-only: pulls this package's LocaleNamespaceMap merge (the 'feedback' seat).
import type {} from './locales.ts'
import type { FeedbackActionResult, FeedbackView } from './controller.ts'

/** Injected business face of one assistant-message feedback entry. */
export interface FeedbackInjected {
  hooks: {
    /** The owning Session's feedback view, shared by every message control. */
    feedback: HostObservable<FeedbackView>
  }
  /** Load the Session's feedback once, on first interaction. */
  ensure: () => Promise<FeedbackActionResult>
  /**
   * Create or replace this Session's feedback for one message.
   * @param messageId - target assistant message.
   * @param rating - desired judgment.
   * @param note - optional explanation.
   */
  rate: (
    messageId: MessageId,
    rating: MessageFeedbackRating,
    note?: string,
  ) => Promise<FeedbackActionResult>
  /**
   * Remove this Session's feedback for one message.
   * @param messageId - target assistant message.
   */
  clear: (messageId: MessageId) => Promise<FeedbackActionResult>
}

/** Full props of one assistant-message feedback entry. */
export type FeedbackActionProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<FeedbackInjected>
  & PropsLocale<'feedback'>
