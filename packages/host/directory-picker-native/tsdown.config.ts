import { clientBundle } from '../../client/tsdown.client.ts'

// The Win32 dialog worker builds as its own CJS entry (mirroring
// dsh-workflow-workerthread's worker): path-loaded by the driver, inlining
// the dialog logic while koffi stays an external native require.
export default [
  ...clientBundle('@deepseek-ai/dsh-host-directory-picker-native', ['lib/types/index.js', 'lib/types/invariant.js']),
  {
    entry: ['lib/types/win32-dialog-worker.js'],
    outDir: 'lib',
    format: ['cjs'] as ['cjs'],
    platform: 'node' as const,
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
]
