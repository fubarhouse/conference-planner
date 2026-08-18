import globals from 'globals';
import prettier from 'eslint-config-prettier';

// Pragmatic flat config: catch real problems (unused/undeclared vars, loose
// equality, var, empty blocks) without style noise — Prettier owns formatting.
export default [
  {
    ignores: [
      'node_modules/**',
      'cache/**',
      'private/**',
      'app/css/utilities.css',
      'gpx-creator/**',
      'terraform/**',
    ],
  },

  // Browser front-end
  {
    files: ['app/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Chart.js is loaded from a CDN <script> in planner.html (a bare global).
      globals: { ...globals.browser, Chart: 'readonly' },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // Node back-end + scripts
  {
    files: ['lib/**/*.js', 'scripts/**/*.mjs', 'server.js', '*.config.js', 'uno.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-undef': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },

  // Vitest test files
  {
    files: ['**/__tests__/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  prettier,
];
