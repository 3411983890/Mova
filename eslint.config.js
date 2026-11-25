import js from '@eslint/js';
import globals from 'globals';

// The design/ folder is a historical design draft (see README), vendor/ is
// third-party, and dist/ is a build artifact: none of them are linted.
export default [
  {
    ignores: [
      'node_modules/**', 'dist/**', 'dist-edge/**', 'design/**', 'vendor/**',
      'scripts/probes/**', '.mova-backups/**', 'assets/**', '**/*.min.js',
      'mobile/**', // Independent Expo/TypeScript project; use mobile's own checks.
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['electron/**/*.{js,cjs,mjs}', 'scripts/**/*.{mjs,cjs}', 'tests/**/*.mjs', '*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        // Node 18+ exposes these globally but older `globals` releases omit them.
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        structuredClone: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    // The shell entry keeps browser globals: app.js plus every renderer module
    // under src/ (features are per-directory since the restructure).
    files: ['**/*.jsx', 'src/**/*.js', 'app.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Loaded by vendor/emotion-ball/*.js before app.js runs.
        EmotionBall: 'readonly',
      },
    },
  },
  {
    files: ['edge-extension/*.js'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    // The prototype keeps a few intentional patterns that the recommended set
    // treats as errors; they are visible as warnings instead of failing CI.
    // `no-useless-assignment` is new in the shared config and flags the
    // "declare null, assign in try" idiom used across the older main-process
    // modules — benign, so it reports instead of blocking.
    rules: {
      'no-unused-vars': ['warn', { args: 'after-used', ignoreRestSiblings: true, varsIgnorePattern: '^(_|React$)' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-cond-assign': 'off',
      'no-control-regex': 'off',
    },
  },
];
