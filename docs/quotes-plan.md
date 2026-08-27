# Quotes expansion plan — import, Quote of the Day, family links

Status: **planned** (agreed 2026-08-27). Extends the shipped cross-type `quotes`
entity (`apps/server/src/modules/library/quotes.ts`, table in `db/schema.sql`);
nothing here replaces the existing manual add / reader-highlight flows.

Vision: bulk-import quote packs (famous quotes from public-domain datasets,
family sayings) via JSON, and greet whoever opens the app with a Quote of the
Day card on the home feed. Later, link personal quotes to Family Tree persons
and show them on the person's profile.

Design rules carried over from the existing entity:

- **One data type.** Famous, imported, family, and reader-highlight quotes are
  all rows in `quotes`; surfaces (Quotes page, home card, person profile) are
  filters, not separate stores.
- **Degrade, don't cascade.** Links to items/documents/persons are
  `ON DELETE SET NULL` with a text snapshot, matching `source_title` /
  `source_author` today.
- **New visibility axis.** Quotes are per-user private today. The home card and
  person-profile surfaces are inherently shared, so quotes gain
  `visibility: 'private' | 'family'`. Existing rows stay `private`.
- **Curating is an admin act; reading is everyone's.** Importing a pack decides
  what the whole house reads, so it is admin-only (like the GEDCOM import).
  Anyone can still add their own quotes one at a time.
- **Categories are tags**, not a parallel concept — the existing polymorphic
  `taggables` with `entity_type = 'quote'`. Self-curating: every surface offers
  only the categories quotes actually wear, so the list stays short by itself
  and a pack brings its own.

---

## Phase 1 — Schema + editing surface — **DONE** (migration 49)

One migration (next free version in `db/migrate.ts`; also mirror the columns
into `schema.sql`) adding to `quotes`:

| column                  | type / constraint                                              | purpose |
|-------------------------|----------------------------------------------------------------|---------|
| `origin`                | `TEXT NOT NULL DEFAULT 'manual'` — `manual\|reader\|import`    | filter/cleanup; backfill existing rows with a `document_id` to `reader` |
| `visibility`            | `TEXT NOT NULL DEFAULT 'private'` — `private\|family`          | shared surfaces |
| `in_rotation`           | `INTEGER NOT NULL DEFAULT 0`                                   | Quote-of-the-Day pool membership |
| `language`              | `TEXT` (BCP-47 short code: `en`, `ru`)                         | QOTD language preference |
| `quote_date`            | `TEXT` (ISO date, may be partial `YYYY` / `YYYY-MM`)           | when it was said; enables anniversaries |
| `context`               | `TEXT`                                                         | free-text circumstances |
| `family_tree_person_id` | `TEXT REFERENCES family_tree_persons(id) ON DELETE SET NULL`   | speaker link (wired in Phase 4) |
| `person_name`           | `TEXT`                                                         | speaker snapshot for degrade |

Plus a partial index for the pool:
`CREATE INDEX idx_quotes_rotation ON quotes(in_rotation) WHERE in_rotation = 1;`

Note `family_tree_person_id` (speaker — who *said* it) is deliberately separate
from `source_author` (who *wrote* the source work).

Server: extend the POST/PATCH zod schemas and `QUOTE_SELECT`/`publicQuote` in
`modules/library/quotes.ts` with the new fields (person join comes in Phase 4).

Web: `QuotesPage.tsx` add/edit modal gains visibility, rotation, language,
date, and context fields; quote cards show the new metadata. All new strings
are i18n keys in `locales/en/common.json` + `ru/` mirror.

Tests: `quotes-metadata.test.ts` (defaults, derived origin, PATCH round-trip and
clearing, partial-date and enum validation) plus a migration case in
`gallery-slideshow-render.test.ts` that ALTERs a pre-49 quotes table by hand and
checks the `origin` backfill.

Built as planned, with three things worth knowing:

- **`origin` is derived, never accepted from the client** — a document anchor
  means the reader captured it. Sending `origin: "import"` to POST is ignored,
  so nothing can pass itself off as an imported pack.
- **The rotation flag needed its own PATCH setter.** The existing setter treats
  falsy as "clear this column", which is right for an emptied text field and
  would have turned `inRotation: false` into NULL.
- **The card modal could not grow this much.** Adding three rows pushed the
  action row of a `card` Modal past the bottom of a 700px-tall window, with no
  way to scroll to it — `.modal-backdrop` centred its child and hid the
  overflow. Fixed in the shared primitive (`safe` centring + a scrollable
  backdrop), not in the quote form, so every tall card modal benefits.

## Phase 2 — JSON bulk import — **DONE**

`POST /api/library/quotes/import` (authenticated), body:

```json
{
  "version": 1,
  "defaults": { "language": "en", "visibility": "family", "inRotation": true },
  "quotes": [
    { "text": "…", "author": "Mark Twain", "source": "…", "language": "en",
      "date": "1897", "context": "…", "tags": ["humor"] }
  ]
}
```

- `defaults` apply to every row unless the row overrides; imports default to
  `origin='import'`, `visibility='family'`, `in_rotation=1` (the whole point is
  the shared daily card).
- Caps: ≤ 5000 quotes per request; mind Fastify's body-size limit for large
  packs (raise per-route if needed). Per-row zod validation; `text` required,
  trimmed, non-empty, length-capped.
- **Dedup**: skip rows matching an existing quote on
  `(user_id, lower(trim(text)), lower(trim(author)))`; also dedup within the
  batch itself, so re-importing a pack is a no-op.
- `?dryRun=1` validates and returns the summary without writing.
- Response: `{ imported, skippedDuplicates, invalid: [{index, reason}] }`.
- `tags` in rows are stored for Phase 5 wiring (or dropped with a note in the
  summary until Phase 5 lands — decide at build time; storing is preferred).

Web: "Import" button on `QuotesPage` toolbar → `shared/Modal` (card) with file
picker → dry-run preview ("1,240 new, 63 duplicates, 2 invalid") → confirm
runs the real import. Busy state "Importing…". Add filter chips on the page
for origin and rotation so bulk cleanup doesn't mean hunting.

Converter scripts for specific internet datasets (Wikiquote dumps, GitHub
quote collections) are one-off `scripts/` utilities written per source when
needed — not part of the app.

Tests: `quotes-import.test.ts` — dedup (existing, intra-batch, per-user,
re-import no-op), dry run writes nothing, defaults vs row overrides, cap and
version refusal, invalid-row reporting, tag attach and cleanup.

Built as planned. Row `tags` ARE stored (entity_type `quote`), because dedup
would skip every row on a re-import after phase 5 and the tags would be lost for
good. Four things the build turned up:

- **`resetDb()` never cleared `quotes`** — missing since the feature shipped, so
  quotes leaked between tests. Added to the table list.
- **MessageBox wrapped its children in a `<p>`**, making any list inside invalid
  HTML (React hydration warning). The GEDCOM import modal had the same latent
  bug. Fixed in the primitive: the body is now `.message-box-body` (a div).
- **Grouping collapsed every author-without-source quote into one bucket.** That
  is the shape of nearly every imported famous quote, so a 1,200-line pack landed
  as a single "Unattributed" group wearing whichever author arrived first. Quotes
  with no source title now group by author and wear that name.
- **Deleting a quote left its tag rows behind** — `taggables` carries no FK, so
  every other delete path clears it by hand; the quote route now does too.

Still open: a `docs/users/` guide. Quotes shipped without one, and the plan pairs
the guide with Quote of the day, so it is written in phase 3 rather than written
now and rewritten then.

## Revision — 2026-08-27, after the first import landed

Three changes agreed once phase 2 was working, all now built except the widget:

1. **Import is admin-only.** `requireAdmin` on the route; the Import button shows
   for admins only. A member gets 403, on dry runs too.
2. **The Quotes page is the family's library, not just yours.** It lists your own
   quotes plus every quote marked `family`, whoever saved it. Others' are
   read-only (no edit/delete) and carry a "saved by X" line; a *Just mine* filter
   narrows back down. Without this an admin-imported pack was invisible to
   everyone but the admin — the page filtered on `user_id` alone.
   The reader's `?documentId=` call still returns ONLY your own highlights.
3. **Categories via tags**, wired end to end: a type-ahead field in the editor
   (suggesting categories already in use), chips on each card that filter the page
   when clicked, and the eight most-used categories as filter chips. Imported
   packs bring their tags with them.

The daily card below therefore gains a **category switcher**: everyone sees the
same library, and each viewer chooses which category their own daily quote comes
from. "Funny things the kids said" is then just a `Kids` category — with phase 4
adding who said it as a family-tree link.

## Phase 3 — Quote of the Day home card — **DONE**

New card type in `modules/home/feed.ts`:

```ts
export interface QuoteCard {
  type: "quote";
  quoteId: string;
  text: string;
  author: string | null;   // person_name ?? source_author
  source: string | null;
}
```

- **Lifetime class: today-only**, like the gallery memory card — same quote all
  day, replaced at midnight. Score just below `MEMORY_SCORE` (e.g. `1.5`) so a
  memory outranks it but it sits above routine activity.
- **Pool**: `in_rotation = 1 AND (visibility = 'family' OR user_id = :me)`,
  narrowed to the viewer's chosen category when they have picked one.
- **Category switcher on the card.** The viewer picks which category their daily
  quote comes from (All / Funny / Kids / …), offered from the categories the pool
  actually uses. The choice is a per-viewer convenience, so it lives in
  `localStorage` — no schema, and it never needs to reach another device.
- **Deterministic pick, no stored state**: order the pool by `id`, index =
  `dayNumber % pool.length` where `dayNumber` hashes the server-local
  `YYYY-MM-DD` (matching the memory card's local-day convention). Everyone in
  the family sees the same quote all day (modulo language, below).
- **Language preference**: the feed request gains an optional `?lang=` sent by
  the web app from `i18n.language`. If the pool has quotes in that language,
  pick within that subset; otherwise fall back to the full pool. No stored
  per-user state.
- Card links to `/quotes`. Empty pool → no card (feed composition already
  tolerates absent card types).

Web: render the `quote` card in the home feed component — typography-led (no
cover image), consistent with the feed card system; i18n for the label
("Quote of the day"), both locales.

Tests: `quotes-daily.test.ts` — same quote all day and a different one tomorrow,
the same quote for everyone in the house, the pool walked rather than repeated,
another user's private quote never in it, category narrowing (case-insensitive)
with a fallback when the chosen category has emptied, language preferred inside
the category with a fallback when the pool does not speak it.

Built as planned. Notes:

- **The pick WALKS the pool** (`YYYYMMDD % length` over an id-ordered pool)
  rather than hashing the date: the house moves one quote further each day, so a
  small library is seen in full instead of repeating at random.
- **The category switcher calls a small endpoint**
  (`GET /api/library/quotes/daily`) rather than reloading the front page — one
  quote swaps, the rest of the feed stays put. Both it and the feed card share
  one `dailyQuote()`, so they can never disagree.
- **A stale category falls back to the whole pool.** The viewer's stored choice
  outlives the quotes that wore it (the last Funny one gets deleted), and a blank
  card would be the wrong answer.
- The viewer's choice lives in `localStorage`; losing it just means the card goes
  back to All.

## Phase 4 — Family Tree speaker link + profile section — **DONE**

Columns already exist from Phase 1; this phase wires them.

- POST/PATCH accept `familyTreePersonId`; validate the person exists **and the
  caller can see them** via `modules/familytree/access.ts` (tag-scoped access —
  do not invent a parallel check). Snapshot the person's display name into
  `person_name` at link time.
- `QUOTE_SELECT` left-joins `family_tree_persons` for the live name; fall back
  to the snapshot when the person is gone (same pattern as item metadata).
- Person profile (`features/familytree/FamilyPersonPage.tsx`) gains a Quotes
  section: `GET /api/library/quotes?personId=` returning quotes for that person
  with `visibility='family'` plus the caller's own private ones, access-checked
  through the same familytree access rules.
- Web: speaker picker in the quote add/edit modal (person search against the
  family tree); the profile section lists quotes with date/context and links
  into `/quotes`.

Tests (in `quotes-metadata.test.ts`): the link round-trips with a name snapshot,
a rename is followed (live name beats the snapshot), deleting the person keeps
the quote AND its attribution, an unknown speaker 404s on both write paths,
unlinking clears the snapshot too, and the per-person listing honours visibility.

Built as planned, with one deliberate departure:

- **No edit right on the person is required to link a quote to them.** The plan
  said to gate on `familytree/access.ts`, but reading the tree is open to every
  signed-in user and the thing being edited is the QUOTE, not the person —
  requiring branch-edit rights would stop a member recording something their own
  grandmother said. The gate that matters is the quote's own visibility, which
  the per-person listing applies.
- The id and the name snapshot always move together: unlinking clears both, so a
  quote can never keep claiming a speaker it is no longer attached to.
- The profile section READS quotes and sends editing back to the Quotes page —
  a quote is its own entity, and one editor is enough.
- Phase 3's attribution (`person_name ?? source_author`) now flows from this, so
  a linked quote shows the speaker on the daily card automatically.

## Phase 5 — Collections (tags done in the revision above)

- ~~**Tags**~~ — done: `entity_type = 'quote'` through the import, the editor,
  the card chips and the page filter. What is left here is collections.
- **Collections**: add `quote` to `SUBJECTS` in `modules/social/subjects.ts`
  with `collectable: true` and a `hydrateQuotes` hydrator (title = truncated
  text, subtitle = author, no cover, `href: /quotes?…`).
  **Standing footgun**: every `AddToCollectionModal` call site must pass
  `entityType="quote"` explicitly — the prop defaults to `"audiobook"`.

Tests: hydrator availability/visibility (another user's private quote is not
`available`), tag attach/detach, import-with-tags.

## Phase 6 (later) — Anniversary quotes

When a family quote's `quote_date` month-day matches today, the QOTD card
becomes the anniversary variant ("5 years ago today, …") and outranks the
regular rotation pick. Selection stays a pure function inside the same card
builder — this is the reason the picker is a small server-side function
rather than an inline expression. No schema work needed.

---

## Cross-cutting

- Every phase: `npm run typecheck`, `npm run check:ui`, `npm test`; i18n keys
  added to `en` and `ru` together (check:ui fails on drift).
- User docs: a `docs/users/` guide for Quotes import + QOTD, added to the
  in-app Help page in the same change (check:ui enforces the pairing).
- Phases 1–3 deliver the user-visible goal (import → daily card) and can ship
  as one release; 4 and 5 are independent follow-ups in either order; 6 rides
  on 4.
