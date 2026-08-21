# Family sharing — proposal

Status: **Phases 0, 1 and 2 are BUILT** (see the phase headings); phases 3 and 4
remain proposals. Companion to
[sharing.md](sharing.md) and [library-sharing.md](library-sharing.md), which
describe the guest-link and per-user grants that exist today.

## Goal

Let the household discover, pass around and talk about what is in the library,
**without turning iSputnik into a social network**.

The idea in one line: **content becomes the conversation**. There is no
messenger, no wall, no profiles. A remark about a book lives under that book,
forever, where the next person to open it will find it.

## The rule that keeps this small

Three verbs, in the same place, on everything — a book, a photo, a person in the
family tree:

```
♥ Save     💬 Note     ➦ Send to
```

Nothing new to learn per page, and **no new organizing concept**. The whole
feature is: *see something you like → send it to someone, or write a note under
it.*

## Non-goals

Each of these was considered and dropped on purpose.

| Not building | Why |
| --- | --- |
| Per-post privacy settings | Visibility follows access to the subject. One rule, no dialog. |
| Threads, replies-to-replies, likes, @mentions | Notes are flat. Nesting is what makes a comment section feel like the internet. |
| A stored/fan-out feed table | At five users a union query is cheaper and can never go stale. |
| Aggregate star ratings | An average over n=3 is noise. See Phase 4. |
| A new "shared list" object | Tags, albums, series and My List already group things. See "Collections". |
| Direct sending to another person's Kindle | Mailing a file to someone's device unasked is a bad default. See Phase 1. |

## What already exists

Most of the primitives are in the repo. The audit, so no phase re-invents one:

| Piece | Status |
| --- | --- |
| **Save for Later** | **Built** — `item_saves`, "My List". One row per (user, item). |
| Per-user grants | **Built** — `shares (module, resource_id, user_id, permission)`. Used by gallery albums and sets; `module` is open. |
| Guest links | **Built** — `share_links`, hashed token, expiry, revocation. |
| Send to e-reader | **Built** — `POST /api/library/books/:id/send-to-ereader`, address on `users.ereader_email`. Buried in the book's action menu. |
| Polymorphic entity resolver | **Built, but half-hidden** — `modules/collections/hydrators.ts` answers "given a type + id, what is this and can this user see it". Knows `audiobook · ebook · gallery`. |
| Email notification plumbing | **Built** — `core/notifications.ts`, but exactly one flag (`shareNotifications`), **off by default** and gated on `isMailConfigured()`. |
| Activity log | **Built, wrong table** — `activity_logs` is an *audit* log (IP addresses, redaction, admin-facing). Not a family feed. |
| Attribution-survives-deletion pattern | **Built** — `quotes` snapshots `source_title` / `source_author` so a note outlives its book. Copy this. |

## Mental model

So the features never read as duplicates of each other:

| Surface | Answers | Effort | Who sees it |
| --- | --- | --- | --- |
| My List (`item_saves`) | "what do *I* want to get to?" | one tap | just me |
| Send to | "you specifically should see this" | one tap + a line | one named person |
| Shared with me | "what have people put in front of me?" | none | just me |
| Notes | "here is what I think about this" | typing | anyone who can see the subject |
| Family row | "what has everyone been up to?" | none | everyone, derived |

---

## Phase 0 — Subject resolver (enabler, no user-visible change) — BUILT

Every later phase asks the same question: *given `(entity_type, entity_id)`,
what is this, and may this user see it?* That logic exists once already, in
`modules/collections/hydrators.ts`, but it is scoped to collections and returns
collection-shaped fields.

- **Promote it** to `modules/library/shared/entities.ts` (or a new
  `modules/social/subjects.ts`), returning `{ available, title, subtitle,
  coverUrl, href, kind }`.
- **Widen the type table** beyond `audiobook · ebook · gallery` to include
  `family_tree_person`, and leave the map open for `series` and `gallery_person`.
- Keep the `available: false` degrade — a subject the user cannot see, or that
  was deleted, renders as unavailable rather than 404-ing the page around it.
- **The `libraries.type` filter is load-bearing** and must survive the move: it
  is what stops an ebook id stored with `entity_type='audiobook'` resolving as
  the wrong kind of media.

Skip this and the same access check gets written five times, and will be subtly
wrong in at least two of them.

**As built**: `modules/social/subjects.ts`. `collections/hydrators.ts` is gone and
Collections imports from here. The type table is a registry — each entry carries a
`collectable` flag, so `SUBJECT_ENTITY_TYPES` (all four) and
`COLLECTABLE_ENTITY_TYPES` (the three library types) come off the same map and
cannot drift apart. `hydrateOne()` was added for the single-subject callers.

---

## Phase 1 — Send to — BUILT

The headline feature, and it makes the button count go **down**.

### The problem it solves

Three "send" actions exist today in three different menus, all expressing one
intent — *get this thing to somewhere*:

1. Send to e-reader (book action menu)
2. Create a guest share link (a different menu)
3. Recommend to a family member (new)

### The design

One button on every item. It opens one sheet:

```
Send to…

  👤 Mom
  👤 Anna
  👤 Dad
  ─────────────
  📖 My Kindle
  🔗 Anyone with a link
```

**The destination picks the mechanism** — the user never has to know there is
one. A person gets a pointer; a Kindle gets a file; a link gets a token.

Rules:

- **People first.** Devices and links sit below a divider — they are the rarer
  intent.
- **"My Kindle" appears only for ebooks**, and only when `ereader_email` is set.
  When it is not, the row reads *"Set up my Kindle →"* and deep-links to
  Profile. Better discovery than today, where the feature is invisible until you
  find it in Profile.
- **Sending to a person sends a pointer, not a file.** Nothing leaves the house.
  Say so in the sheet.
- **Never send a file to another person's Kindle**, even though their address is
  on their user row. It lands in their inbox and *they* tap "Send to my Kindle" —
  one extra tap, and the consent stays theirs.
- **Only people who can see the subject are listed.** A recommendation nobody can
  open is a bug, not a feature.

### Where it lands — "Shared with me"

There is **one** page for everything other people put in front of you, not two.

The first cut shipped a separate "Sent to me" beside the existing "Shared with
me", and folding granting into Send to made that untenable: a single act now
writes both a share row and a recommendation, so the same event was reported
twice in two places. The split was ours anyway — in ordinary speech *"Dad shared
this with me"* covers a grant and a pointer alike, and a household should not
have to learn the difference.

So `/shared` has two sections, and a thing is only ever in one of them:

- **Waiting for you** — recommendations still undecided, with Save / Not now
- **Everything else** — the shelf of what you can open, album shares included

Acting on a card moves it down into the shelf. Nothing is lost: **Save** writes
to `item_saves`, and My List is the keeping place. `/inbox` survives as an
alias, because notification emails already sent point at it.

A recommendation with no unread state is just a note with a recipient. So:

- A dot on the Profile control. There is no top bar to hang a bell in, so it
  rides on the control that already opens the menu holding "Sent to me" — which
  also means desktop and the mobile tab bar get it from one place. Not a climbing
  count — see below.
- Opening it shows cards: cover, sender, the one line they typed. Two buttons:
  **Save** and **Not now**.
- **Save** writes to the existing `item_saves`. That is how Save-for-Later gets
  wired in without building anything.
- **Nothing nags.** The dot counts what has not been LOOKED AT, not what has not
  been acted on, and opening the page clears it. Deciding about each card is a
  separate, unhurried thing — so no count ever climbs to 47.

### Schema

```sql
CREATE TABLE IF NOT EXISTS recommendations (
  id            TEXT PRIMARY KEY,
  from_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,          -- resolved via Phase 0
  entity_id     TEXT NOT NULL,
  message       TEXT,                   -- one line, plain text, capped
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'saved', 'dismissed')),
  -- Snapshot so the card still reads if the subject is deleted (quotes pattern).
  subject_title TEXT,
  from_name     TEXT,
  created_at    TEXT NOT NULL DEFAULT (...),
  seen_at       TEXT,
  UNIQUE (from_user_id, to_user_id, entity_type, entity_id)
);
```

New table, so it auto-applies with no `migrations[]` entry (see CLAUDE.md).
`from_user_id` is `SET NULL` + `from_name` snapshot so a removed account does not
erase what it sent.

### Endpoints — as built

- `GET  /api/social/destinations?entityType=&entityId=` — the sheet's contents,
  already access-filtered and already knowing whether the e-reader applies.
- `POST /api/social/recommendations` — `{ toUserIds[], entityType, entityId, message }`.
  Plural on the wire even though the UI sends one, so multi-select stays a client
  decision. Re-sending is an upsert, not a duplicate card.
- `GET  /api/social/inbox` · `GET /api/social/inbox/summary` (the dot) ·
  `POST /api/social/inbox/seen`
- `POST /api/social/recommendations/:id/save` · `/dismiss`

### Email — as built

A second flag in `core/notifications.ts` (`recommendationNotifications`), same
discipline: **off by default**, gated on `isMailConfigured()`, its own switch on
the Notifications tab so an admin who wanted share mail has not thereby agreed to
mail the household every time someone passes a book along. The in-app inbox is the
primary channel precisely because most installs will never configure SMTP.

### What Phase 1 shipped with

- `modules/social/` — `routes.ts`, `notify.ts`, `subjects.ts`
- `features/social/` — `SendToSheet.tsx`, `InboxRow.tsx`, `useInboxSummary.ts`
- `SharedWithMePage` absorbed the inbox; one nav entry, `/inbox` aliased to it
- `test/social-send-to.test.ts` — 16 cases, mostly about the ways it must say no

All three surfaces are wired, and each shows only the destinations that apply:

| Surface | People | E-reader | Guest link |
| --- | --- | --- | --- |
| Ebook detail | yes | when `ereader_email` is set | yes |
| Audiobook detail | yes | — | yes |
| Gallery lightbox | yes | — | yes |
| Family-tree person | yes | — | — (no public page to link to) |

On the book detail page and the gallery lightbox this **replaced** the separate
"Share" action; on books it replaced "Send to e-reader" as well. Choosing
"Anyone with a link" closes the sheet and opens each page's existing share
modal, so the guest-link flow itself is untouched.

### Granting folded in — the fourth destination

The share modal used to have a **People** tab that granted another account access
to the item. Two paths that both said "people" was the exact duplication this
document set out to remove, and it had a worse symptom: Send to listed only people
who could already open a thing, so the answer to *"why isn't Mom in the list?"*
lived in a different dialog.

Now there is one list, in two halves:

```
Send to…

  👤 Anna                            ← can open it; sending is a pointer
  ─────────────
  DOESN'T HAVE ACCESS YET
  👤 Mom            will get access  ← sending also grants read access
```

- **Nobody is hidden.** Somebody who cannot open the subject is listed and
  labelled, so the reason is on screen rather than in another menu.
- **The grant is never implicit.** The compose step says
  *"Mom can't open this yet. Sending will also give them access to it."* and the
  button reads **Give access and send**. The client must pass `grantAccess`;
  the server does nothing extra without it.
- **Permission is unchanged.** Widening access still needs the curate capability
  (`canGrantItemAccess`). A view-only member sees who is missing, labelled
  *"no access"* on a disabled row, and cannot be the one to fix it.
- **One implementation.** `grantItemAccess()` in
  `modules/library/shared/shares.ts` is now the only code that widens access;
  `POST /api/shares/user` is a thin wrapper over it. Two code paths that both
  grant is how they drift apart.
- **The People tab kept the half it is good at** — who has access, and revoking
  it — and points at Send to for the other half.

Family-tree persons never offer this: everyone signed in can already read the
tree, so `canGrant` is false and there is nothing to widen.

---

## Phase 2 — Notes — BUILT

Open anything, scroll down, a box that says *"Add a note…"*. Type, post. The
note lives under that book/photo/person for good.

- **Flat.** One level of reply at most; realistically, none. Nesting is what
  turns a comment box into a comment section.
- **Plain text, stored and rendered as text.** No markdown, no HTML. That is the
  entire XSS story, and it stays that way.
- **Length-capped**, and covered by the existing global rate limiter.
- **Soft delete** — author or admin. Removing a note leaves the thread's shape
  intact.
- **Called "Notes", not "Comments"**, everywhere. On a photo of a grandparent who
  has died, *"0 comments · Reply"* reads badly; *"Add a note"* does not.

### Where they appear

Book and ebook detail, gallery lightbox, family-tree person, and — if
collections survive — a collection.

### Schema

```sql
CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name   TEXT,                   -- snapshot, as above
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (...),
  updated_at    TEXT NOT NULL DEFAULT (...),
  deleted_at    TEXT
);
CREATE INDEX ... ON notes (entity_type, entity_id, created_at);
```

### Visibility

**If you can see the subject, you can see its notes.** No per-note audience, no
picker. Two carve-outs, both important:

- **Quotes and highlights stay private.** They are per-user today. Nothing in
  this proposal retroactively publishes them.
- **Family-tree persons are readable by everyone signed in.** An earlier draft of
  this document claimed the tag scoping in `modules/familytree/access.ts` gated
  reads and called it the one real trap here. It does not: it governs EDITING, and
  the schema says so outright ("Any signed-in user can view; only admins edit").
  So person notes need no special case — they follow the same rule as everything
  else. Checked while building Phase 0.

### Who may post — changed while building

This document said `member` or above, so a `viewer` would read and not post.
**Built the other way: if you can see it, you can write on it.** Phase 1 settled
it — somebody who can see a thing may already *Send* it to a family member with a
message attached, so refusing them a note on the same thing is incoherent. And
the accounts the stricter rule would silence are exactly the view-only ones, the
children, whose remarks on the family photographs are the point of the feature.

The upside is that there is now **one** rule rather than two: visibility and the
right to post are the same question, asked once, of the subject resolver. Still
no new permission axis.

### What Phase 2 shipped with

- `modules/social/notes.ts` — list · post · soft-delete, three routes
- `features/social/NotesSection.tsx`, dropped on book detail, the family-tree
  person page, and the gallery lightbox's info panel (`compact`)
- `test/social-notes.test.ts` — 14 cases, including that markup survives the
  round trip as the literal text it was typed as
- The person page's **Notes** tab, which held one admin-edited biography field,
  is now called **Biography**. Two things called Notes on one page is worse than
  a rename, and the tab id was never in the URL.

Not built, deliberately: editing a note. Delete and repost is enough at this
size, and an edit history is a feature this does not want yet.

---

## Phase 3 — The family row

One row on the Home dashboard, reading as sentences:

```
Mom added 12 photos to Summer 2019      · 2h
Anna left a note on "Dune"              · yesterday
Dad sent you "The Hobbit"               · Tuesday
```

Tap a line, land on the thing. A `/activity` page shows the longer list.

- **Derived, never stored** — a capped `UNION ALL` over `notes`,
  `recommendations`, new `library_items`, and family-tree edits, ordered by
  `created_at`, then access-filtered through Phase 0. At household scale this is
  a few milliseconds and it can never disagree with reality.
- **Not `activity_logs`.** That table is the security audit trail; it carries IP
  addresses and redaction rules and belongs to the control panel.
- Home conventions apply: fixed-width tiles, no horizontal scroll, row hidden
  when empty.

**Built third on purpose.** A feed shipped before there is anything to feed it is
an empty box that teaches the family the feature is dead.

---

## Phase 4 — Ratings — maybe never

Personal ★1–5 plus one optional line, shown on the detail page as
*"Dad ★★★★☆ — drags in the middle"*.

**No averages, no sort-by-rating, no review pages.** An aggregate over three
opinions is not information. Revisit only if the family asks for it after
phases 1–3 have been live a while.

---

## Collections: demote, do not delete

The dev database, after collections have been shipped for months:

```
collections        0
collection_items   0
tags             587      ← how organizing actually happens here
gallery_albums     1
item_saves         1
```

Zero rows. Building a collection is *work* — decide it should exist, name it,
go find things to put in it. Send-to and Notes cost one tap on something already
on screen, which is why they will get used and this did not.

**But do not remove it:**

1. **It is shipped** (v3.10.x is on ghcr). Zero rows in *this* database is not
   zero rows in someone else's, and deleting a released feature that holds user
   data is the one genuinely destructive move available here.
2. **The valuable code is not the feature** — it is `hydrators.ts`, which Phase 0
   harvests.

So:

- **Harvest** the resolver (Phase 0).
- **Demote** the feature: drop "Add to collection" from item action menus
  (11 call sites) and from the main nav; keep it reachable from Profile.
- **Revisit in a major version.** If it is still untouched some months after
  Phase 3 ships, remove it then with a release note.

And note what already replaced it: **tags** (587 rows, polymorphic, in daily
use), **My List**, and two lists Phase 1 generates for free —
*"Recommended by Dad"* and *"Recently discussed"*. Those are the collections a
family will actually use, because nobody has to build them.

---

## Cross-cutting decisions

- **Access is checked at read, not only at write.** A subject that becomes
  invisible later degrades to `available: false`; it does not leak and it does
  not 404 the page.
- **Deleted users and deleted items never erase what was said.** `SET NULL` plus
  a name/title snapshot, exactly as `quotes` does it.
- **Everything is undoable.** No action in this proposal deletes content or can
  lock anyone out.
- **Schema**: `recommendations` and `notes` are new tables, so they auto-apply
  with no `migrations[]` entry. Any new *column* on an existing table (none
  planned) would still need a real migration.
- **UI**: the action row goes through `shared/Button`; the destination sheet and
  any confirm go through `shared/Modal` / `shared/ConfirmDialog`. Nothing
  hand-rolled. `npm run typecheck` and `npm run check:ui` after each phase.
- **Mobile/PWA**: the action row must work at ≤740px, and density changes stay
  inside the mobile media queries — never in base rules.
- **Docs**: `check:ui` fails when a guide in `docs/users/` is not listed on the
  in-app Help page. Each phase owes a user guide (likely one page,
  `docs/users/family-sharing.md`, grown per phase).

## Open questions

1. ~~Where the bell lives on mobile.~~ **Settled while building**: there is no top
   bar on either breakpoint, so the dot rides on the Profile control, which already
   opens the menu holding "Sent to me". No fifth tab, one implementation for both.
2. **Notes on gallery items**: per photo, or per album/folder? Per photo is the
   obvious answer but it means a note on one of 400 holiday photos is nearly
   unfindable. Possibly both, with the album view rolling up its photos' notes.
3. **Should "Send to" accept more than one recipient at once?** The API already
   takes an array; the sheet sends one. One recipient reads as personal, multi-select
   edges toward broadcast — so it stays single until someone asks.
