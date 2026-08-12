/** Pure replay-safe render intents for Cordis tools. */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/** Render a runtime-inspection call. */
export function presentRuntimeInspectCall(args: { what?: string; name?: string }): GenericCallView {
  const target = args.name === undefined ? args.what : `${args.what}: ${args.name}`
  return { card: 'generic', kind: 'read', title: target === undefined ? 'Inspect Cordis runtime' : `Inspect Cordis runtime: ${target}` }
}

/** Render provider-directory inspection. */
export function presentInspectListCall(): GenericCallView {
  return { card: 'generic', kind: 'read', title: 'List Cordis Inspect Providers' }
}

/** Render one provider query. */
export function presentInspectQueryCall(args: { platform: string; provider: string; method: string }): GenericCallView {
  return { card: 'generic', kind: 'read', title: `Query Cordis ${args.platform} ${args.provider}.${args.method}` }
}

/** Render layered self-inspection. */
export function presentInspectSelfCall(args: { pluginId?: string; packageId?: string }): GenericCallView {
  const target = args.pluginId === undefined
    ? 'dynamic Cordis Plugins'
    : args.packageId === undefined ? args.pluginId : `${args.pluginId}/${args.packageId}`
  return { card: 'generic', kind: 'read', title: `Inspect ${target}` }
}

/** Render an immutable Package source-inspection call. */
export function presentPackageInspectCall(args: { pluginId: string; packageId: string }): GenericCallView {
  return { card: 'generic', kind: 'read', title: `Inspect Cordis Package ${args.pluginId}/${args.packageId}` }
}

/** Render a new or appended Package definition. */
export function presentDefineCall(args: {
  plugin: { kind: 'new'; idPrefix: string } | { kind: 'existing'; pluginId: string }
  name: string
  purpose: string
  code: { host?: string; client?: string }
}): GenericCallView {
  const target = args.plugin.kind === 'new' ? `new ${args.plugin.idPrefix}-*` : args.plugin.pluginId
  return {
    card: 'generic',
    kind: 'execute',
    title: `Define Package "${args.name}" for ${target}: ${args.purpose}`,
    rawInput: args.code,
  }
}

/** Render Plugin removal. */
export function presentUndefineCall(args: { pluginId: string }): GenericCallView {
  return { card: 'generic', kind: 'delete', title: `Remove dynamic Plugin ${args.pluginId}` }
}

/** Render one exact Package activation. */
export function presentRunCall(args: { pluginId: string; packageId: string; mode: 'run' | 'update' }): GenericCallView {
  return {
    card: 'generic',
    kind: 'execute',
    title: `${args.mode === 'update' ? 'Update' : 'Run'} ${args.pluginId} · ${args.packageId}`,
  }
}

/** Render Plugin stop. */
export function presentStopCall(args: { pluginId: string }): GenericCallView {
  return { card: 'generic', kind: 'execute', title: `Stop dynamic Plugin ${args.pluginId}` }
}
