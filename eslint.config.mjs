import stylistic from '@stylistic/eslint-plugin'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

/**
 * ESLint flat config. Two layers:
 *
 * 1. typescript-eslint strict-type-checked — correctness rules that need the
 *    type checker. The headline rules for this codebase: no-floating-promises
 *    and no-misused-promises (an un-awaited promise in the agent loop is our
 *    primary bug class), switch-exhaustiveness-check (we switch over
 *    merge-extensible unions everywhere).
 * 2. @stylistic — formatting (2-space, no semicolons, single quotes, trailing
 *    commas), so style is enforced rather than drifting between agents.
 *
 * vendor/ is linted lightly (style only stays OFF — vendored code keeps
 * upstream style; only a few safety rules apply there) and examples/tests are
 * linted with relaxed unsafe-* rules where mocks intentionally bend types.
 */
export default tseslint.config(
  {
    ignores: [
      '**/lib/**',
      '**/node_modules/**',
      '**/.sessions/**',
      '.claude/**', // harness-local state (worktrees, skills) — other checkouts, not this one's sources
      '**/.doc-typecheck-*/**',
      'vendor/**', // vendored source keeps upstream style and idioms
      '**/*.js',
      '**/*.mjs',
      '*.config.ts', // root tool configs (vitest, tsdown) — no project service
    ],
  },

  // --- our packages: full strictness -------------------------------------
  {
    files: ['packages/*/*/src/**/*.ts', 'examples/**/*.ts', 'scripts/**/*.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // One shared tsserver-style project service instead of 60+ standalone
        // per-package programs: the old `project` glob built every package's
        // full dependency closure (sibling sources via the dev `paths` map +
        // the vendored Cordis stack) as its own program and kept them all
        // resident — ~5 GB peak, an OOM past node's default heap. The service
        // resolves each file to its nearest owning tsconfig and shares the
        // graph.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The bug class this repo cares most about: lost promises in the loop.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', {
        considerDefaultExhaustiveForUnions: true,
      }],
      '@typescript-eslint/no-unnecessary-condition': ['error', {
        allowConstantLoopConditions: true,
      }],
      // `any` requires a justification comment — enforced as: no bare casts.
      '@typescript-eslint/no-explicit-any': 'error',
      // Style points where the codebase intentionally diverges from preset:
      '@typescript-eslint/no-namespace': 'off', // Cordis Config-namespace idiom
      '@typescript-eslint/no-empty-object-type': 'off', // merge-extensible maps
      '@typescript-eslint/no-invalid-void-type': 'off', // event signatures
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
      }],
      // `void foo()` in arrow listeners is our idiom for intentional fire-and-forget
      'no-void': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  // --- examples: demo code conforms to async interfaces without awaiting ---
  {
    files: ['examples/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },

  // --- tests: same rules, minus the friction that fights test ergonomics --
  {
    files: ['packages/*/*/tests/**/*.ts', 'examples/*/tests/**/*.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // Same shared project service as the src block: test files resolve
        // through the root tsconfig (its include covers every tests/ tree).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off', // assertions follow expect()s
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/require-await': 'off', // mock execute() signatures
      '@typescript-eslint/no-empty-function': 'off', // stub agents
      '@typescript-eslint/only-throw-error': 'off', // testing non-Error throws
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  // --- file-local duplication (all owned TypeScript) ---------------------
  {
    files: ['packages/**/*.ts', 'examples/**/*.ts', 'scripts/**/*.ts'],
    plugins: { sonarjs },
    rules: {
      // Cross-file clones are covered separately by jscpd.
      'sonarjs/duplicates-in-character-class': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-duplicate-in-composite': 'error',
      'sonarjs/no-duplicate-test-title': 'error',
      'sonarjs/no-identical-conditions': 'error',
      'sonarjs/no-identical-expressions': 'error',
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-duplicated-branches': 'error',
    },
  },

  // --- formatting (everything we own) -------------------------------------
  {
    files: ['packages/**/*.ts', 'examples/**/*.ts', 'scripts/**/*.ts', 'eslint.config.mjs'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/indent': ['error', 2],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/arrow-parens': ['error', 'as-needed', { requireForBlockBody: true }],
      '@stylistic/member-delimiter-style': ['error', {
        multiline: { delimiter: 'none' },
        singleline: { delimiter: 'semi', requireLast: false },
      }],
      '@stylistic/max-len': ['error', { code: 140, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true }],
    },
  },
)
