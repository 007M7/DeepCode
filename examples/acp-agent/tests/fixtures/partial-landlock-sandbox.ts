import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'

const NOTICE = 'landlock-run: partial enforcement (older Landlock ABI)'

/**
 * Snapshot-only provider that reproduces an older-ABI Landlock launch. Keep
 * its failure tuple aligned with `sandbox-local`'s Landlock runner rule.
 */
export default class PartialLandlockSandboxProvider extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [
        'bash',
        '-c',
        `printf '%s\\n' '${NOTICE}' >&2; exec "$@"`,
        'partial-landlock-run',
        ...argv,
      ],
      enforcement: 'partial',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{
        allowedExitCodes: [125],
        fatalSignatures: ['landlock-run: '],
        informationalLines: [NOTICE],
      }],
    }
  }
}
