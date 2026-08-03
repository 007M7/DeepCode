/**
 * A per-agent persona as a composable row.
 *
 * `dsh-system-prompt` owns the global persona as its own config, and registers
 * that section unconditionally — so this row is **scope-only**. Mounted inside
 * an agent preset it shadows the deployment persona for that one session,
 * exactly like the per-child persona `dsh-subagent` installs; mounted globally
 * it collides with the registry's own registration and fails loud.
 *
 * That constraint is the reason the row exists. An agent preset cannot mount
 * the prompt registry itself, so without a row of its own a preset could
 * change an agent's tools but never its identity.
 * @module @deepseek-ai/dsh-persona
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** The section name this plugin registers; the prompt registry's persona slot. */
export const PERSONA_SECTION = 'deployment:persona'

/** Prompt order of the persona slot, matching the registry's own default. */
export const PERSONA_ORDER = 0

/** Cordis plugin name. */
export const name = 'persona'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Plugin config: the persona text this composition contributes. */
export interface Config {
  /**
   * Persona prose rendered as the `deployment:persona` section. A template:
   * complete `{{…}}` groups interpolate strictly against registered prompt
   * variables. Empty text drops the section at render, matching the registry.
   */
  text: string
}

/** Runtime schema for the persona row. */
export const Config: z<Config> = z.object({
  text: z.string().required(),
})

/**
 * Register the persona section for the mounting context's scope.
 * @param ctx - an agent scope context; an unscoped context collides with the
 * prompt registry's own persona registration and rejects.
 * @param config - the persona text.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: config.text,
  }), 'persona.section()')
}
