import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Standard browser globals
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        // Web Crypto API and structured clone - available in modern browsers and Electron
        crypto: 'readonly',
        structuredClone: 'readonly',
        // Animation frame API - available in browsers and Electron
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        // jQuery and toastr - provided by SillyTavern host page
        $: 'readonly',
        jQuery: 'readonly',
        toastr: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
];
