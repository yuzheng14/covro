import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/codex/generated/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['bin/process-darwin.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ObjC: 'readonly', $: 'readonly', Ref: 'readonly' },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
