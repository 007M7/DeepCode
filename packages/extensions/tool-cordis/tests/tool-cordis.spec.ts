import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as tool from '../src/index.ts'
import { setup } from './helpers.ts'

/**
 * Export shape and registration API: the namespace-plugin contract the
 * real Loader path depends on, the registered tool set, and the Config
 * validator's defaults and rejections.
 */

describe('export shape', () => {
  it('has no default export, and survives the real Loader unwrapExports', () => {
    // A stray `export default` would make `unwrapExports` (`exports.default ??
    // exports`) collapse the module to the bare function and DROP `inject`,
    // crashing at real load (docs/postmortem/0001). Assert directly AND through
    // the real unwrap so adding `export default apply` fails here.
    expect('default' in tool).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-cordis')
    expect(unwrapped.inject).toEqual(['tools', 'dynamicCordisRunner'])
    expect(typeof unwrapped.apply).toBe('function')
    // The vm bound moved to the runner service with the sandbox it bounds, so
    // this toolset has no config of its own.
    expect('Config' in tool).toBe(false)
  })
})

describe('tool registration', () => {
  it('registers the six cordis tools with split inspection schemas', async () => {
    const ctx = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining([
      'cordis_runtime_inspect', 'cordis_package_inspect', 'cordis_define',
      'cordis_run', 'cordis_stop', 'cordis_undefine',
    ]))
    // The one-shot mount pair retired with the two-step verbs.
    expect(names).not.toEqual(expect.arrayContaining(['cordis_mount']))
    expect(names).not.toEqual(expect.arrayContaining(['cordis_unmount']))
    const inspect = ctx.tools.schemas().find(schema => schema.name === 'cordis_runtime_inspect')!
    const props = (inspect.parameters as { properties: Record<string, { enum?: string[]; type?: string }> }).properties
    expect(props.what?.enum).toEqual(['services', 'plugins', 'tools', 'temporary', 'api', 'events', 'client'])
    expect(props.name?.type).toBe('string')
    const packageInspect = ctx.tools.schemas().find(schema => schema.name === 'cordis_package_inspect')!
    const packageProps = (packageInspect.parameters as { properties: Record<string, { type?: string }> }).properties
    expect(packageProps).toMatchObject({ pluginId: { type: 'string' }, packageId: { type: 'string' } })
  })
})
