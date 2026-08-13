/**
 * Fixed DeepCode terminal product identity. Runtime capabilities remain
 * plugin-owned; this module only prevents visible branding from drifting
 * between the welcome card, live status, and composer.
 * @module @deepseek-ai/dsh-cli-app/brand
 */

/** Product name displayed by the local interactive terminal. */
export const PRODUCT_NAME = 'DeepCode'

/** Prompt label for ordinary chat input. */
export const CHAT_PROMPT_LABEL = `Ask ${PRODUCT_NAME}`

/** Text shown before the first streamed response delta. */
export const WORKING_LABEL = `${PRODUCT_NAME} is working…  Esc/Ctrl+C to cancel`
