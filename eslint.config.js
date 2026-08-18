import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'build/**', 'node_modules/**', 'protocol/**', '.playwright/**'],
  },
  js.configs.recommended,

  // The TypeScript sources are linted with type information: the rules that
  // matter most here (floating promises, misused promises, unsafe assertions)
  // cannot be checked without it.
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      // node:test's describe/it return promises the runner owns; everything
      // else on this wire must be awaited or explicitly voided.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: ['it', 'describe', 'test'], package: 'node:test' },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      // stdout carries frames and nothing else; a stray write desyncs the wire.
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      curly: ['error', 'all'],
    },
  },

  // Build and release tooling: plain ESM, run by hand and by CI, and expected
  // to talk to the operator on stdout.
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      curly: ['error', 'all'],
    },
  },
);
