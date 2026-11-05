// The CI lint gate: BUG rules only, nothing stylistic. It blocks a pull request only on the lines the pull request
// ADDED (scripts/ci-lint-changed.mjs). Every rule here is proven live on each run by the canaries in canary/: a
// rule switched off makes its canary go silent, and the gate refuses to run.
import tseslint from "typescript-eslint";

export const BUG_RULES = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  // `x == null` / `x != null` (null OR undefined) is a deliberate idiom here: all 34 loose comparisons on main were
  // exactly that (MEASURED, 5 Nov). Every other loose comparison is still an error.
  eqeqeq: ["error", "always", { null: "ignore" }],
  "@typescript-eslint/no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
};

export default [
  {
    files: ["**/*.ts", "**/*.mts", "**/*.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ["./tsconfig.lint.json"], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: BUG_RULES,
  },
];
