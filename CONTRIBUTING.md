# Contributing

Thanks for looking. Before you invest time, one thing to be clear about:

**This is a personal project, developed heavily with AI assistance, and it is
not stable.** Features, the database schema, the API, and the UI change often,
sometimes with breaking changes and without migrations. The direction is driven
by what one family actually needs. That shapes what kinds of contribution are
useful here.

## What helps most

- **Bug reports.** Genuinely valuable — you are running the app on hardware and
  media the maintainer does not have. Use the issue forms; they ask for the
  version, the deployment method, and the logs, which is almost always what the
  first reply would have asked for anyway.
- **Feature ideas**, as issues rather than pull requests. Say what you are
  trying to do, not just the feature you imagine — the underlying need is often
  solvable in a way that fits the existing design better.
- **Documentation fixes.** If a guide in [`docs/users/`](docs/users/README.md)
  is wrong, confusing, or out of date, a small PR is very welcome.

## Pull requests

Small, focused PRs — a bug fix, a doc correction, a scanner pattern for a
naming convention the parser misses — are welcome.

**Please open an issue before starting anything large.** Big features, module
rewrites, dependency swaps, and refactors are likely to be declined, not
because they are bad but because they collide with in-flight work or with a
design direction that is not written down yet. Asking first costs you one
message and can save you a weekend.

By contributing, you agree that your contribution is licensed under the
[GNU AGPL-3.0](LICENSE), the same license as the project.

## Working on the code

The project is npm workspaces: `apps/server` (Fastify + SQLite) and `apps/web`
(React + Vite PWA).

```bash
npm install
npm run dev          # server on :4000 + Vite dev server
```

Before opening a PR:

```bash
npm run typecheck    # both workspaces
npm run check:ui     # UI-convention checker
npm test             # server test suite (Vitest)
```

`npm run check:ui` is not optional for UI work — it enforces the conventions in
[`docs/UI-CONVENTIONS.md`](docs/UI-CONVENTIONS.md), such as never hand-rolling a
modal and never using `window.confirm`. It also fails when a guide in
`docs/users/` is not listed on the in-app Help page.

> ⚠️ Never run `npx vitest` from the repository root — it misses the in-memory
> database setting and will wipe a live development database. Use `npm test`.

Architecture, the schema, and the design notes behind each module are in
[`docs/architecture.md`](docs/architecture.md). The core rule to know before
adding code: `apps/server/src/core/` is platform infrastructure only, and
product features live in `apps/server/src/modules/`, with media types nested
under `modules/library/`.

## Commits

Commit messages follow a `type(scope): summary` form — `fix(gallery):`,
`feat(familytree):`, `perf(scanner):` — with the summary written as a plain
statement of what changed for the user.

## Conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
