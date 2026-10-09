import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const sources = [
  "apps/**/*.{js,mjs,cjs,ts,tsx}",
  "packages/**/*.{js,mjs,cjs,ts,tsx}",
  "dsh-slidestudio/**/*.{js,mjs,cjs,ts,tsx}",
  "scripts/**/*.{js,mjs,cjs,ts,tsx}",
  "*.config.mjs",
];

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "dsh-slidestudio/lib/**",
    "packages/dsh-slides-client/lib/**",
    "vendor/**",
    "_reference/**",
    "output/**",
    ".dsh/**",
    ".runtime/**",
    ".local/**",
    ".scratch/**",
  ]),
  {
    files: sources,
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Report existing cleanup debt without turning tooling adoption into a
      // repository-wide refactor. Correctness rules still block commits.
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
      // The source-quality ratchet separately blocks new/growing exceptions.
      complexity: ["warn", 20],
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "no-dupe-keys": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: [
      "scripts/**/*.{js,mjs,cjs,ts}",
      "apps/*/src/**/*.mjs",
      "apps/*/tests/**/*.mjs",
      "packages/**/*.{js,mjs,ts,tsx}",
      "dsh-slidestudio/**/*.{js,mjs,ts,tsx}",
      "*.config.mjs",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      "apps/native-web/public/**/*.js",
      "apps/web/src/**/*.{ts,tsx}",
      "packages/dsh-slides-client/src/**/*.{ts,tsx}",
      "dsh-slidestudio/src/client/**/*.{ts,tsx}",
      "dsh-slidestudio/scripts/**/*.mjs",
      "apps/native-web/src/**/*.test.mjs",
      "scripts/**/*.mjs",
      "scripts/**/public/**/*.js",
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["apps/native-web/public/app.js"],
    // These classic scripts run before the editor module in index.html.
    languageOptions: {
      globals: {
        shapePaintMarkup: "readonly", // shape-paint.js
        computeSnapGuides: "readonly", // snap-guides.js
        animationGroups: "readonly",
        staggerDelays: "readonly",
        isDarkCss: "readonly",
      },
    },
  },
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
]);
