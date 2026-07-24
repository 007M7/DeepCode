/**
 * Web model-selector plugin, node half. Model routing and catalog RPCs belong
 * to the host runtime, so this package contributes no host registration.
 */
import type { Context } from 'cordis'

/** No host services are required. */
export const inject: string[] = []

/**
 * Empty host half for the browser-only selector feature.
 * @param _ctx - Host plugin context.
 */
export function apply(_ctx: Context): void {}
