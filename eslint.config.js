import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Import ordering shared by every linted file.
 */
const importOrder = [
  "error",
  {
    groups: [
      ["builtin", "external"],
      "internal",
      ["parent", "sibling", "index"],
      "type",
    ],
    "newlines-between": "always",
    alphabetize: { order: "asc", caseInsensitive: true },
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.tsbuild/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/blob-report/**",
      "**/.claude/**",
      "**/.local/**",
    ],
  },

  // Plain JavaScript tooling files: no type-aware linting, Node globals.
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
    },
    plugins: { import: importPlugin, unicorn },
    rules: {
      "import/order": importOrder,
      "unicorn/prefer-node-protocol": "error",
    },
  },

  // All TypeScript: type-aware linting plus JSDoc obligations.
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      jsdoc.configs["flat/recommended-typescript-error"],
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin, unicorn },
    settings: {
      "import/resolver": { typescript: true, node: true },
    },
    rules: {
      "import/order": importOrder,

      // The constitution forbids classes outright; an Error subclass is the
      // sole exemption, granted case by case with an inline disable.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ClassDeclaration",
          message:
            "Classes are forbidden; use functions and plain data. Error subclasses are the sole exemption.",
        },
        {
          selector: "ClassExpression",
          message:
            "Classes are forbidden; use functions and plain data. Error subclasses are the sole exemption.",
        },
      ],

      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],

      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
        },
      ],
      "jsdoc/require-param-description": "error",
      "jsdoc/require-returns-description": "error",
      "jsdoc/tag-lines": "off",

      "unicorn/filename-case": [
        "error",
        {
          case: "camelCase",
          ignore: ["^[A-Z][A-Za-z0-9]*\\.tsx$"],
        },
      ],
      "unicorn/prefer-node-protocol": "error",
      "unicorn/prefer-string-replace-all": "error",
      "unicorn/prefer-top-level-await": "error",
      "unicorn/throw-new-error": "error",
    },
  },

  // React console.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [react.configs.flat.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    settings: { react: { version: "19.2" } },
    rules: {
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/jsx-pascal-case": "error",
      "react/jsx-boolean-value": ["error", "never"],
      "react/self-closing-comp": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // Tests lean on the assertion library's shapes rather than on precise types.
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      // Bun's matchers are typed as returning void although the rejection
      // matchers do return a promise, and dropping the await would let a
      // failing expectation pass unnoticed.
      "@typescript-eslint/await-thenable": "off",
    },
  },
);
