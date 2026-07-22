/**
 * Pure-library module-table seed. These are the ONLY entities statically
 * built into the shell bundle besides the loader machinery — every plugin
 * (including the infrastructure four) arrives as a dynamic bundle and
 * resolves its externals against this table through the loader's require.
 * Keys must match the tsdown client preset's external specifiers
 * (packages/client/tsdown.client.ts CLIENT_EXTERNALS ∩ pure libraries).
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from 'cordis'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as WebReact from '@deepseek-ai/dsh-client-web-react'
import * as WebReactStore from '@deepseek-ai/dsh-client-web-react/store'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Build the seed table handed to the loader machinery at boot.
 * @returns module specifier → export-surface entity.
 */
export function seedModules(): Record<string, unknown> {
  return {
    'react': React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    'cordis': Cordis,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
    '@deepseek-ai/dsh-client-web-react': WebReact,
    '@deepseek-ai/dsh-client-web-react/store': WebReactStore,
    '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
  }
}
