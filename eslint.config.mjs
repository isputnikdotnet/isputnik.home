// Lint for both workspaces: `npm run lint`, and CI runs it beside typecheck.
//
// tsc --strict already does the heavy lifting; this catches what the compiler
// can't — dead variables, misused hooks, stray `any` — and gives the
// `eslint-disable` comments already in the code something to disable.
//
// React hooks: only the two classic rules. v7's "recommended" set adds the React
// Compiler rules (set-state-in-effect, refs, purity, …), which would flag most of
// the app at once; adopt those deliberately, one rule at a time. exhaustive-deps
// is a warning, not an error — the codebase has hundreds of effects written before
// anything checked them, and a warning is visible without blocking a release.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/web/public/**",
      "apps/web/dev-dist/**",
      "apps/web/src/vendor/**",
      "apps/server/models/**",
      "data/**",
      "coverage/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_name` marks a deliberately unused parameter or binding.
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true
      }],
      "@typescript-eslint/no-explicit-any": "warn",
      // Flags `let size = 0; try { size = statSync(p).size } catch {}` — the house
      // pattern for a best-effort value with a fallback. Not a defect; off.
      "no-useless-assignment": "off",
      // A redundant backslash in a regex (often `\-` in a class, kept for clarity) is
      // style, not a bug.
      "no-useless-escape": "warn"
    }
  },
  {
    files: ["apps/server/**/*.ts", "scripts/**/*.{js,mjs}", "apps/*/scripts/**/*.{js,mjs}", "*.{js,mjs}", "apps/*/*.config.ts"],
    languageOptions: { globals: globals.node }
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "apps/web/test/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
