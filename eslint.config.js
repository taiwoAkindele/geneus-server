// Lint enforces the readability rules in CLAUDE.md that the formatter cannot:
// braces on every block, no nested ternaries, no `any`, no silently empty blocks.
// Formatting itself belongs to Prettier (`npm run format`), so no style rules live here.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'shared/**',
      'dist/**',
      'dev-dist/**',
      'public/**',
      'artifacts/**',
      'design/**',
      'qa/**',
      'powersync/**',
      'context/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      curly: ['error', 'all'],
      // One declaration per statement: `const a = 1, b = 2` hides the second name.
      'one-var': ['error', 'never'],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-nested-ternary': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/ban-ts-comment': 'error',
    },
  },
  {
    // In tests a non-null assertion fails loudly at the exact line, which is what a test wants.
    files: ['**/*.test.{ts,tsx}', 'tests/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
