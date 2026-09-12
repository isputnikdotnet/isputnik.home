// Lint for both workspaces: `npm run lint`, and CI runs it beside typecheck.
//
// tsc --strict already does the heavy lifting; this catches what the compiler
// can't — dead variables, misused hooks, stray `any` — and gives the
// `eslint-disable` comments already in the code something to disable.
//
// React hooks: the two classic rules plus six of v7's React Compiler rules, adopted
// one at a time and smallest first — use-memo, static-components, immutability, purity,
// preserve-manual-memoization, refs. Every finding each one raised was fixed in the
// code; one suppression survives from the earlier rounds, in FolderCompare, where the
// memo the compiler will not keep is the one that makes a thousand-file folder page at
// all (its reason is in the file).
//
// refs was the last of them and the one that changed real behaviour. Most of its 46
// findings were the "latest value" idiom — a ref written while rendering so a handler
// registered once still calls today's closure — and every one of those writes moved
// into an effect, where it lands after the commit rather than during it. FamilyTreeChart
// was the genuine bug: it measured the SVG with getBoundingClientRect() mid-render to
// place the zoom readout and the card menu, and now observes its own box into state.
// What is left suppressed is the ten places the rule cannot see are safe — seeding
// state from a value computed once at mount (EbookReader), Modal's lazily-made portal
// host, and four handlers reached straight from JSX: two that mark the row being
// dragged, two clicks that reach a ref the render before them wrote. Each says why
// where it sits.
//
// One is still pending, large enough to be its own piece of work: set-state-in-effect
// (132 findings across 94 files). Turning it on is a decision about the shape of the
// app, not a lint tidy-up.
//
// exhaustive-deps is an ERROR since every one of its 128 warnings was worked
// through (4.1.x): the ones that were bugs — a stale language, a stale media type,
// a search race — are fixed, and the effects that mean to ignore a value say so in
// a disable comment with its reason. A new one is a question to answer, not a
// warning to walk past. Stale disable comments are reported too, so a suppression
// that has stopped suppressing anything gets deleted rather than inherited.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
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
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/use-memo": "error",
      "react-hooks/static-components": "error",
      "react-hooks/immutability": "error",
      "react-hooks/purity": "error",
      "react-hooks/preserve-manual-memoization": "error",
      "react-hooks/refs": "error"
    }
  }
);
