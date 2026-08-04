import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import {
  LAUNCHER_FAILURE_EXIT,
  LAUNCHER_FATAL_PREFIX,
  PARTIAL_ENFORCEMENT_NOTICE,
} from 'node-addon-landlock-run'

/** Snapshot-only provider that reproduces an older-ABI Landlock launch. */
export default class PartialLandlockSandboxProvider extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return {
      argv: [
        'bash',
        '-c',
        `printf '%s\\n' '${PARTIAL_ENFORCEMENT_NOTICE}' >&2; exec "$@"`,
        'partial-landlock-run',
        ...argv,
      ],
      enforcement: 'partial',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{
        allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
        fatalSignatures: [LAUNCHER_FATAL_PREFIX],
        informationalLines: [PARTIAL_ENFORCEMENT_NOTICE],
      }],
    }
  }
}
