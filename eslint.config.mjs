// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "**/*.config.ts"] },
  js.configs.recommended,
  {
    // Library + CLI source. Type-aware rules need a tsconfig that includes
    // these files; tsconfig.eslint.json widens the build config to cover tests.
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Type-only imports go through a module-level `import type` (never inline
      // `import("…").Type`, banned below via no-restricted-syntax).
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      // Static enforcement of the prose Code Conventions in CLAUDE.md that
      // /review used to catch by eye. Zero current violations — drift insurance.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Use a named export, not a default export.",
        },
        {
          selector: "TSImportType",
          message:
            'No inline import("…").Type — use a module-level `import type { … } from "…"`.',
        },
        {
          selector: "CallExpression > FunctionExpression.callee",
          message:
            "No IIFEs — extract a named helper or compute the value with a plain expression.",
        },
        {
          selector: "CallExpression > ArrowFunctionExpression.callee",
          message:
            "No IIFEs — extract a named helper or compute the value with a plain expression.",
        },
        {
          selector: "CallExpression[callee.property.name='then']",
          message: "Favor async/await over a .then() chain.",
        },
        {
          selector:
            "CallExpression[callee.name='test'][callee.type='Identifier']",
          message: "Use it() from Vitest, not test().",
        },
      ],
      // Source-level half of the file-length ratchet (CI backstop is
      // scripts/check-file-length.mjs). Hard ceiling at 2x the 240 split point.
      "max-lines": [
        "error",
        { max: 480, skipBlankLines: false, skipComments: false },
      ],
    },
  },
  {
    // Tests — longer ceiling, matching the ratchet's test limit. The two
    // type-checked rules below misfire on standard vitest mock idioms:
    // `vi.mocked(obj.method)` (unbound-method) and mock `Response.json/text`
    // that mirror the real async signature without awaiting (require-await).
    files: ["src/**/*.test.ts", "src/__tests__/**/*.ts"],
    rules: {
      "max-lines": ["error", { max: 720 }],
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Repo-level JS scripts (the CI gates themselves) — node globals, no
    // type-aware rules since they sit outside the TS project.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
);
