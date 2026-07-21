/** Lint-lane selection for GitHub Actions. */

/** One ESLint target set and whether it owns the cross-file duplication gate. */
export interface LintSelection {
  /** Shell-free arguments passed to ESLint before its cache options. */
  eslintTargets: readonly string[]
  /** Whether this lane also runs the repository-wide duplication check. */
  includeDuplication: boolean
}

/**
 * Select an exhaustive lint partition without changing the ordinary local lint command.
 *
 * @param name Optional stable shard name from `DSH_LINT_SHARD`.
 * @returns ESLint targets and ownership of the duplication gate.
 */
export function selectLintShard(name?: string): LintSelection {
  switch (name) {
    case undefined:
    case '':
      return { eslintTargets: ['.'], includeDuplication: true }
    case 'package-sources-a-c':
      return { eslintTargets: ['packages/[a-c]*/*/src/**/*.ts'], includeDuplication: false }
    case 'package-sources-d-m':
      return { eslintTargets: ['packages/[d-m]*/*/src/**/*.ts'], includeDuplication: false }
    case 'package-sources-n-s':
      return { eslintTargets: ['packages/[n-s]*/*/src/**/*.ts'], includeDuplication: false }
    case 'package-sources-t-z':
      return { eslintTargets: ['packages/[t-z]*/*/src/**/*.ts'], includeDuplication: false }
    case 'package-sources-a-m':
      return { eslintTargets: ['packages/[a-m]*/*/src/**/*.ts'], includeDuplication: false }
    case 'package-sources-n-z':
      return { eslintTargets: ['packages/[n-z]*/*/src/**/*.ts'], includeDuplication: false }
    case 'package-tests-a-c':
      return { eslintTargets: ['packages/[a-c]*/*/tests/**/*.ts'], includeDuplication: false }
    case 'package-tests-d-m':
      return { eslintTargets: ['packages/[d-m]*/*/tests/**/*.ts'], includeDuplication: false }
    case 'package-tests-n-s':
      return { eslintTargets: ['packages/[n-s]*/*/tests/**/*.ts'], includeDuplication: false }
    case 'package-tests-t-z':
      return { eslintTargets: ['packages/[t-z]*/*/tests/**/*.ts'], includeDuplication: false }
    case 'package-tests-a-m':
      return { eslintTargets: ['packages/[a-m]*/*/tests/**/*.ts'], includeDuplication: false }
    case 'package-tests-n-z':
      return { eslintTargets: ['packages/[n-z]*/*/tests/**/*.ts'], includeDuplication: false }
    case 'repository':
      return {
        eslintTargets: [
          '.',
          '--ignore-pattern',
          'packages/*/*/src/**',
          '--ignore-pattern',
          'packages/*/*/tests/**',
        ],
        includeDuplication: true,
      }
    default:
      throw new Error(`run-gates: unknown DSH_LINT_SHARD ${JSON.stringify(name)}.`)
  }
}
