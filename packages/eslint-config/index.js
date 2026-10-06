import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Shared flat ESLint config: strict TypeScript, no `any`, explicit return types. */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-warning-comments': ['error', { terms: ['todo', 'fixme'], location: 'anywhere' }],
      eqeqeq: ['error', 'always'],
    },
  },
);
