# Contributing

Thanks for looking. Before you invest time, one thing to be clear about:

**This is a personal project, developed heavily with AI assistance, and it is
in Beta.** Upgrades are safe for data — every schema change ships as a
migration, and the server copies the database before a new version touches it —
but features, the API, and the UI still change often, and the direction is
driven by what one family actually needs. That shapes what kinds of
contribution are useful here.

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
npm test             # both test suites
```

`npm test` runs both suites; `npm run test:server` (Vitest, in-memory SQLite,
tests in `apps/server/test/`) and `npm run test:web` (Vitest + jsdom + Testing
Library, tests in `apps/web/test/`) run one each. CI runs all four checks on
every push to `main` and every pull request, and a release tag publishes an image
only when they pass.

`npm run check:ui` is not optional for UI work — it enforces the conventions in
[`docs/UI-CONVENTIONS.md`](docs/UI-CONVENTIONS.md), such as never hand-rolling a
modal and never using `window.confirm`, and that the English and Russian
translation keys stay in step. It also fails when a guide in `docs/users/` is not
listed on the in-app Help page.

Two test hazards worth knowing before you write one:

> ⚠️ Never run `npx vitest` from the repository root — it misses the in-memory
> database setting and will wipe a live development database. Use the npm
> scripts, or `npx vitest --root apps/server`.

> ⚠️ A test that registers the backups plugin runs `rescueStrandedBackups()`,
> which **moves** every backup out of `<process.cwd()>/data/backups` — under
> Vitest, that is your own development backups folder, and a test that deletes
> its temp directory afterwards deletes them for good. Mock `process.cwd()` to
> the test's temp folder first, as `backup-restore-covers.test.ts` and
> `backup-path-rescue.test.ts` do.

If a server test worker dies mid-run with no error ("Worker exited
unexpectedly" — which is how a native crash looks), `CRASH_LOG=<file> npm test`
arms a probe (`apps/server/test/helpers/crash-probe.ts`) that logs which file and
which test the worker was on when it went.

Schema changes: a new table goes straight into
`apps/server/src/db/schema.sql`; a new column on an existing table also needs a
migration: a new `NNN-short-name.ts` in `apps/server/src/db/migrations/`, listed in
that folder's `index.ts`. See [`docs/database.md`](docs/database.md).

User guides live in [`docs/users/`](docs/users/README.md) and ship inside the
app. `npm run docs:shots` regenerates their screenshots in `docs/users/images`:
it needs `npm run dev` running, Chrome or Edge, and an admin account in the
development database, and takes name fragments to redo only some
(`npm run docs:shots -- storage 31`).

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
