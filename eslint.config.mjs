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
      "@typescript-eslint/consistent-type-imports": "error",
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
