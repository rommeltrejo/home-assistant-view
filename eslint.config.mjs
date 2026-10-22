import js from '@eslint/js';
import globals from 'globals';

const appGlobals = Object.fromEntries(['APP', 'WEBVIEW', 'EVENTS'].map(name => [name, 'readonly']));

export default [
  { ignores: ['node_modules/**', 'out/**', 'js/hardware.js', 'js/integration.js'] },
  {
    files: ['ha.view/**/*.{js,cjs,mjs}', 'index.js', 'forge.config.js', 'tools/**/*.{js,cjs,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser, ...appGlobals, ARGS: 'writable' },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'warn',
      'no-constant-condition': 'warn',
      'no-control-regex': 'off', // Input validation explicitly rejects C0 characters.
      'no-unused-vars': 'off', // Legacy callback signatures and integration mocks retain unused placeholders.
      'no-empty': 'off', // Legacy cleanup and optional API catches intentionally ignore failures.
      'no-sparse-arrays': 'off', // Sparse fixture arrays intentionally exercise malformed data.
      'no-useless-escape': 'off', // Preserve literal regular-expression patterns from validated code.
      'preserve-caught-error': 'off', // Privacy-preserving errors intentionally omit internal details.
      'no-unassigned-vars': 'off', // Renderer lifecycle initializes observers asynchronously.
    },
  },
];
