/** Bridges the `conversation` locale namespace to the zero-cordis attachment
 * atoms' label props (`@deepseek-ai/dsh-client-ui-attachment` reads no
 * application state; owners resolve every string). */

import type {
  AttachmentRailLabels, ImageLightboxLabels, MessageImageLabels,
} from '@deepseek-ai/dsh-client-ui-attachment'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from './locales.ts'

/**
 * Resolve the original-image lightbox strings.
 * @param t - the conversation-namespace translate.
 * @returns the lightbox dialog and close-control labels.
 */
export function lightboxLabels(t: Translate<ConversationKey>): ImageLightboxLabels {
  return { dialog: t('image.preview'), close: t('image.closePreview') }
}

/**
 * Resolve the chat-history image strings.
 * @param t - the conversation-namespace translate.
 * @returns the message-image labels including the forwarded lightbox strings.
 */
export function messageImageLabels(t: Translate<ConversationKey>): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: lightboxLabels(t),
  }
}

/**
 * Resolve the composer draft-image rail strings.
 * @param t - the conversation-namespace translate.
 * @returns the rail group, open-tooltip, and paging-arrow labels.
 */
export function attachmentRailLabels(t: Translate<ConversationKey>): AttachmentRailLabels {
  return {
    group: t('image.pending'),
    open: t('image.openOriginal'),
    scrollLeft: t('image.scrollLeft'),
    scrollRight: t('image.scrollRight'),
  }
}
