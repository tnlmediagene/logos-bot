// @ts-check
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

/**
 * Flat config (ESLint 10 only supports flat config — no .eslintrc).
 *
 * Deliberately lightweight: the Worker and Node sides share one TS dialect
 * and most of the same rules, so one config covers both rather than
 * mirroring the tsconfig.json / tsconfig.worker.json split. Type-aware
 * rules (`recommended-type-checked`) are skipped — they need a `project`
 * pointed at a tsconfig that includes every linted file, which neither of
 * ours does on its own, and the Worker/Node split makes a single
 * all-encompassing tsconfig more trouble than the extra rules are worth
 * here. `tsc --noEmit` / `tsc -p tsconfig.worker.json` already catch type
 * errors in CI; this config is for style/correctness lint, not typing.
 */
export default [
  {
    ignores: ["node_modules/**", "dist/**", "data/**", ".wrangler/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // The codebase leans on `any` deliberately at Slack/D1/Workers API
      // boundaries (see slack-app.ts, d1-catalog-repo.ts) where the
      // upstream types are awkward to satisfy exactly — warn, don't block.
      "@typescript-eslint/no-explicit-any": "off",
      // Unused function args are common in handler signatures that must
      // match a framework's callback shape; only flag unused *variables*.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `no-undef` can't see TS-only globals/ambient types and double-counts
      // what tsc already checks far more precisely.
      "no-undef": "off",
    },
  },
];
