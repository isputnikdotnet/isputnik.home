# AGENTS.md

The instructions for coding agents working in this repository live in
[`CLAUDE.md`](CLAUDE.md) — read it first and follow it; it is the one kept up to
date. It covers the commands (`npm run dev`, `typecheck`, `check:ui`, the two test
suites), the test-safety rules (never run `npx vitest` from the repo root; the
backups-plugin and two-`sharp`-pipelines hazards), the repo-root files that must not
be deleted, the server's core-vs-modules rule, and the web app's UI, i18n, browse-page
and control-panel conventions (full reference: `docs/UI-CONVENTIONS.md`).
