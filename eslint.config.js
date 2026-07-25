import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default defineConfig([
  // public/remoteEntry.js + *.mjs are the generated config-panel bundle;
  // the rest of public/ is the hand-written webapp.
  globalIgnores([
    "dist",
    "node_modules",
    "public/remoteEntry.js",
    "public/*.mjs",
  ]),

  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },

  // Webapp: vanilla browser ES modules, no build step (served from public/).
  {
    files: ["public/**/*.js"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      sourceType: "module",
      globals: globals.browser,
    },
  },

  // Browser-side config panel (webpack + babel-loader, not tsc).
  {
    files: ["src/configpanel/**/*.jsx"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    rules: {
      // Classic JSX runtime: React must stay imported even though only the
      // compiled createElement calls reference it.
      "no-unused-vars": ["error", { varsIgnorePattern: "^React$" }],
    },
  },

  // The panel build config (CommonJS because the package itself is ESM).
  {
    files: ["webpack.config.cjs"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
]);
