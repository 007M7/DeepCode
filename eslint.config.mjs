import stylistic from '@stylistic/eslint-plugin'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

// Strict type-aware correctness rules plus repository formatting. Tests/examples relax deliberate
// mock unsafety; vendored sources retain upstream style and receive only selected safety checks.
export default tseslint.config(
  {
    ignores: [
      '**/lib/**',
      '**/node_modules/**',
      '**/.sessions/**',
      '.claude/**', // harness-local state (worktrees, skills) — other checkouts, not this one's sources
      '**/.doc-typecheck-*/**',
      'vendor/**', // vendored source keeps upstream style and idioms
      'native/**', // imported landlock-run subtree: self-contained workspace with its own gates (native/README.md)
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
        // One project service resolves each file to its owning tsconfig and shares dependency
        // graphs. Per-package programs duplicated path-mapped and Cordis closures, reaching ~5 GB.
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
    files: ['packages/*/*/tests/**/*.ts', 'examples/*/tests/**/*.ts', 'scripts/**/*.spec.ts'],
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
