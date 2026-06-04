# Testing data

A reusable, regenerable database fixture seeded with fake audiobook data and a
known admin account, for exercising the UI at scale without touching real data.

---

## What you get

- A known admin login:
  - **email:** `test@test.com`
  - **password:** `test1234`
- 3 audiobook libraries and **1,000 books** with metadata, file rows, authors,
  narrators, series, categories, tags, and a spread of listening-progress states.
- Letter-fallback covers only — there are **no real audio files**, so browsing,
  search, filtering, and detail views work, but playback does not.

The fixture is deterministic (no randomness) and regenerated from scratch each
run, so it never needs to be committed. It lives under the gitignored `data/`
folder.

---

## Generate it

```
npm run seed:testing --workspace apps/server
```

- Script: `apps/server/src/scripts/seed-testing.ts`
- Output: `data/db/testing/isputnik-testing.sqlite`
- Path is `config.testingDbPath` (override with the `TESTING_DB_PATH` env var). It
  is kept independent of `DB_PATH` so it always resolves under the repo's
  `data/db/testing` directory.

Adjust the library/book counts and vocabulary at the top of the script.

---

## Load it into the app

Control Panel → **Maintenance → Backup → "Load testing data"**.

1. A **full backup of the current library is taken first** (DB + covers). If that
   backup fails, nothing is changed.
2. The fixture is staged as `<dbPath>.restore`.
3. On the **next server restart**, `db.ts` swaps it in (and also snapshots the
   current DB to the backups folder as a second safety net).
4. Sign in with the known admin above.

To return to your real library, restore the backup created in step 1 from the
backup list, then restart again.

Endpoint: `POST /api/testing/load-database` (admin only), in
`apps/server/src/core/backups.ts`. It reuses the same staged-restore mechanism as
the Backup screen, so the swap-on-restart behaviour is identical.

---

## Notes

- Loading is **destructive on restart** — it replaces the live database. Intended
  for throwaway / testing environments.
- 1,000 books is a deliberate stress test of the current client-side load-and-
  filter approach (the audiobook page fetches and renders all books at once). If
  it feels slow, that's the signal to move to a backend-backed search/pagination.
