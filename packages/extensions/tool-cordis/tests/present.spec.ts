import { describe, expect, it } from 'vitest'
import {
  presentDefineCall, presentPackageInspectCall, presentRunCall, presentRuntimeInspectCall,
  presentStopCall, presentUndefineCall,
} from '../src/present.ts'
import { setup } from './helpers.ts'

describe('Cordis tool presenters', () => {
  it('renders runtime and Package inspection as read calls', () => {
    expect(presentRuntimeInspectCall({ what: 'api', name: 'tools' })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Inspect cordis runtime: api: tools',
    })
    expect(presentPackageInspectCall({ pluginId: 'clock-1', packageId: 'pkg-2' })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Inspect Cordis package clock-1/pkg-2',
    })
  })

  it('renders versioned define and lifecycle calls', () => {
    expect(presentDefineCall({
      plugin: { kind: 'existing', pluginId: 'clock-1' },
      name: 'Clock v2',
      purpose: 'show seconds',
      code: { host: 'HOST', client: 'CLIENT' },
    })).toEqual({
      card: 'generic',
      kind: 'execute',
      title: 'Define clock-1 package "Clock v2": show seconds',
      rawInput: { host: 'HOST', client: 'CLIENT' },
    })
    expect(presentRunCall({ pluginId: 'clock-1', packageId: 'pkg-2', mode: 'update' })).toEqual({
      card: 'generic', kind: 'execute', title: 'Update clock-1 with pkg-2',
    })
    expect(presentStopCall({ pluginId: 'clock-1' })).toEqual({
      card: 'generic', kind: 'execute', title: 'Stop dynamic plugin clock-1',
    })
    expect(presentUndefineCall({ pluginId: 'clock-1' })).toEqual({
      card: 'generic', kind: 'delete', title: 'Remove dynamic plugin clock-1',
    })
  })

  it('wires the split inspection presenters onto their tools', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('cordis_runtime_inspect')!.presentCall!({ what: 'tools' })).toMatchObject({
      kind: 'read', title: 'Inspect cordis runtime: tools',
    })
    expect(ctx.tools.get('cordis_package_inspect')!.presentCall!({
      pluginId: 'clock-1', packageId: 'pkg-1',
    })).toMatchObject({
      kind: 'read', title: 'Inspect Cordis package clock-1/pkg-1',
    })
  })
})
