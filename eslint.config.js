import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default defineConfig([
  globalIgnores(["dist", "node_modules"]),

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
]);
