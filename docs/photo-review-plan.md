# Photo review — plan

Status: shipped in v3.71.0–v3.76.1 (2026-09-07 to 2026-09-08); kept for history.
Every phase, 0 to 4, is built and nothing is open.

As built: **Phases 1 and 2 built in-code (2026-09-07)** — migration 70, the
review fields on `gallery_details`, Review mode at `/gallery/review/:libraryId`,
the Home card and Inbox page hooks, and the guide section in
[users/photo-inbox.md](users/photo-inbox.md#6-ask-someone-what-they-know).
**Phase 0 built in-code the same day**: migration 71 and one `house_library`
setting (`modules/library/gallery/house-library.ts`) that stories, the family
tree and the slideshow movie dialog read through to; Control → Settings →
Gallery holds it and sets up a Photo Inbox in one step. **Phase 3 built the
same day**: "Ask what they remember" on Send to for an album — the album share
carries `permission = 'edit'` (open question 1 answered: the grant is per
album, bounded by the sender's own curate right, not per item), migration 72
adds `recommendations.ask_notes`, the card opens Review mode at
`/gallery/review/album/:id`. **Phase 4 built 2026-09-08**: dictation into
the notes box (Web Speech API, `review/useDictation.ts`) and voice notes kept
on the photo (`gallery_voice_notes` tying the photo to an audio asset in the
house library under `Voice notes/<year>`, streamed through the photo's own
route so reach follows the photo). Nothing of this plan remains a proposal.
Written 2026-09-07 from a conversation about
scanning a box of childhood prints and asking a relative who was there to say
where and when each was taken. Companion to [photo-inbox-proposal.md](photo-inbox-proposal.md)
(the holding place this stands on), [gallery-library.md](gallery-library.md),
[permissions.md](permissions.md) and [family-sharing-proposal.md](family-sharing-proposal.md).
Like the other proposals, decisions are recorded so they need not be re-argued;
open questions are recorded so they are not silently answered by whoever writes
the code first.

Mock (private link, kept for reference while building): the Review screen,
interactive, landscape and portrait, English and Russian —
https://claude.ai/code/artifact/79489e90-c69b-42e3-8cac-02c59649c883

## Goal

A person who is **not technical, is 76, and uses a tablet** can go through a
batch of scanned photos and, for each one, say **when** it was taken, **where**,
**who** is in it, and write a few lines about it. She should never see a grid, a
pencil icon, a map pin, a comma-separated list or a Save button. What she writes
lands on the photo itself, so the Timeline, the map, People and every story that
later uses the photo get it for free.

The person doing the scanning should be able to **hand a batch over** and later
see what came back, then file the photos with the dates already right.

The idea in one line: **the Inbox is already the queue; what is missing is a
screen built for the person answering, and two fields the answers need.**

## The mental model

| Question | Answer |
| --- | --- |
| Where do photos wait for notes? | In the **Photo Inbox**, the same holding place they wait in for Keep. A delivery (one scanned box) is one review batch. |
| Who annotates? | Anyone with **contributor** on the Inbox library. Contributor grants edit and upload, not delete, so she cannot Keep or Discard and cannot touch the rest of the collection. |
| What does she see? | One card on her Home page ("Box 3 · 38 photos want your notes"), which opens **Review mode**: one photo at a time, four questions, Previous / Next. |
| What does she write? | When, Where, Who, Notes. All optional. Saved on Next, never with a Save button. |
| When is a photo "done"? | When she pressed Next on it, or **I don't know**. Progress is "12 of 38". |
| What does the scanner see afterwards? | The Inbox page and its Home card show how many are done; Keep files by the dates she set. |

## Non-goals

| Not building | Why |
| --- | --- |
| A new "space" (library, folder, module) for review | Review is a second use of the Inbox. Every other space this app asks an admin to nominate is discussed in Phase 0, where the answer is fewer, not more. |
| A separate notes table for reviewers | Notes are the photo's description, dates are the photo's date. A parallel store would be one more place a fact can live and drift. |
| A per-item Keep/Discard state | Rejected in the Inbox proposal and still rejected. "Reviewed" here means "looked at and answered", a different thing from "kept", and it survives Keep. |
| A wizard that forces an answer | Every field is optional. A forced field on an unknown photo produces a wrong date, which is worse than none. |
| Tablet-specific layout for the rest of the app | Review mode is one screen designed for touch. The gallery, lightbox and Control panel stay as they are. |
| Face recognition inside the review | The Inbox skips faces on purpose. **Who** in Review mode is hand-tagging from a list of names, which is what she knows and the scanner does not. |

## What already exists

| Piece | Status |
| --- | --- |
| A holding place hidden from feeds | **Built** — Photo Inbox: a gallery library with `policy_json.inbox`, excluded from Timeline, Home, People, Memories and every picker (`modules/library/gallery/inbox*.ts`). |
| Deliveries | **Built** — the top-level folder a batch arrived under groups it on the Inbox page (`PhotoInboxDelivery`). |
| Per-photo date, location, description, people, tags | **Built** — `PATCH /api/library/gallery/assets/:id` (`edit.ts`), `POST .../assets/:id/people`; `taken_at_source='manual'` and `gps_source='manual'` protect edits from rescans. |
| Bulk date and place | **Built** — `POST /api/library/gallery/assets/bulk-place-time` (`GalleryDateModal`, `GalleryLocationModal`). |
| A non-admin who can edit but not delete | **Built** — `contributor` role in `assignments`; `canUserWriteLibrary` is `edit` (`library-access.ts:59`). Granted per library in the Library members dialog. |
| A Home card for a non-empty Inbox | **Built** — `PhotoInboxCard` in `modules/home/feed.ts:116`, currently shown only to people who can Keep (`canReview` = delete). |
| Approximate dates | **Built for stories only** — `story_chapters.date` as partial ISO (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) plus `date_approx`. Gallery items have a full instant and nothing else. |
| Place as text | **Not built** — the gallery holds a lat/lng point only; the label you see is geocoded at display time. |
| Russian UI | **Built** — every swept file goes through `t()`; Review mode ships in both languages from day one. |
| A chrome-free full-screen page | **Built** — the story reading view and the drop page both leave the app shell behind; Review mode does the same. |

## Phase 0 — fewer spaces

Today an admin can be asked to nominate **four different gallery libraries**
for things the app itself makes or receives:

| Setting | Where | What lands there |
| --- | --- | --- |
| Photo Inbox flag | Library settings → Access | Scans, uploads and drop-link deliveries that are not in the house yet |
| Recordings library | Control → Stories | Narration recorded or uploaded from the story editor |
| Photo library | Control → Family tree | Photos uploaded from a person's page |
| Movie target | Per slideshow | Rendered slideshow movies saved back to a library |

The question that started this plan was whether the Inbox and the Stories
space should be one. **Decision: no, because they mean opposite things.** The
Inbox holds what is *not yet* part of the collection and exists to be emptied.
The other three hold things the family *made in the app* and that are part of
the collection the moment they exist; nobody should review a narration before
it counts. Folding the Inbox into them would put unreviewed prints back on the
Timeline, which is the one thing the Inbox exists to prevent.

What *is* worth combining is the other three. They are one question asked three
times: "where do things made in the app go?"

**Decision: one house setting, `Made in the app`, replaces the three.** It is
one gallery library nominated once under Control → Gallery, and each source
writes into a fixed subfolder of it:

| Source | Subfolder |
| --- | --- |
| Story narration | `Recordings/` |
| Family-tree uploads | `Family tree/` |
| Rendered slideshow movies | `Movies/` |
| Voice notes on photos (Phase 4) | `Voice notes/` |

The audio scan extensions are merged into that library once, at nomination,
exactly as `ensureAudioScanExtensions` does today for the recordings library.
The three existing settings become read-through aliases of the one, migrated
by copying the first non-null of them (recordings first, since it is the one
most likely to already exist); the per-slideshow movie target stays as an
*override* on the slideshow because a movie is sometimes meant for a
specific library, but its default is now `Movies/` in the house library.
A new install then needs at most **two** nominated libraries: the Inbox and
`Made in the app`, and the review feature adds none.

Also in this phase, because the flag is buried: **Control → Gallery gains a
"Photo Inbox" row** that creates the Inbox library in a chosen storage
container in one step, or points at the existing one. The Access-tab switch
stays for people who want a second Inbox.

Phase 0 is independent of the rest and can ship first or last. It is here
because the review feature must not be the fifth setting.

## Phase 1 — the two missing fields

Both go on `gallery_details`; both are manual-only, so the rescan UPSERT never
writes them (like `rotation`).

**Approximate dates.** `taken_at` stays a full instant, because the Timeline,
the dated Keep layout, Memories and Year in review all sort and bucket on it.
Two columns describe how much of it to believe:

```sql
-- How much of taken_at was actually known. 'time' is what EXIF gives;
-- everything else is a person's answer, stored as the first instant of the
-- period (1962 → 1962-01-01T00:00:00Z) so sorting still works.
taken_precision TEXT NOT NULL DEFAULT 'time'
  CHECK (taken_precision IN ('time','day','month','year','decade')),
-- 1 = "about": displayed as "around 1962" / "around July 1962".
taken_approx    INTEGER NOT NULL DEFAULT 0,
```

Display follows precision everywhere the date is shown: `1962`, `July 1962`,
`around the 1950s`. The Timeline buckets a year-only photo under its year with
no day; the month strip shows it at the start of the year, which is the
honest place for it. The **dated Keep layout** files by precision: `YYYY/` for
year and decade, `YYYY/YYYY-MM` for month, the full `YYYY/YYYY-MM-DD` only for
day and time. The Keep dialog says so in its hint.

`PATCH .../assets/:id` and `bulk-place-time` accept `takenPrecision` and
`takenApprox` beside `takenAt`; the existing date modal gains a precision
picker (Year / Month / Day / Exact) and an "about" toggle, so the scanner can
fix a whole box from the grid as before. Migration 70.

**Place as text.**

```sql
-- What a person called the place ("the dacha in Ratomka"). Manual-only. Shown
-- in preference to the geocoded label when present; the pin, if any, is still
-- gps_lat/gps_lng.
place_text TEXT,
```

Same PATCH and bulk endpoints accept `placeText`. The lightbox Info panel shows
it as the Location line and offers the map pin under it. The map view keeps
using the pin; a photo with text and no pin is simply not on the map, which is
already true today. A later phase can offer "put this on the map" over the
text through the existing geocoder.

**Reviewed.** Two more columns, so progress can be counted and the scanner can
see what came back:

```sql
-- Set when someone finished this photo in Review mode (Next or "I don't
-- know"). Survives Keep. NULL = nobody has looked yet.
reviewed_at TEXT,
reviewed_by TEXT,
```

No foreign key on `reviewed_by`, like `activity_logs`; a deleted account leaves
its name behind. An activity event `library.gallery.reviewed` is logged once per
photo, which puts "Mum went through Box 3" into the Around-the-house feed
without any new card type.

## Phase 2 — Review mode

**Route:** `/gallery/review/:libraryId?folder=<delivery>` — a full-screen page
without the app shell, like the story reading view. It lists the delivery's
photos in file order (the order the box was fed through the scanner, which is
usually the order the prints were in), unreviewed first, then the rest, so
reopening the card continues where she stopped.

**The screen** (tablet, either orientation; the mock shows both):

```
 ┌──────────────────────────────────────────────────────────────┐
 │ ← Box 3                                   12 of 38   ● ● ● ○ │
 ├──────────────────────────────┬───────────────────────────────┤
 │                              │  When was this?               │
 │                              │  [ 1962 ▾ ]  [ month ▾ ]      │
 │                              │  ( ) exactly  (•) about       │
 │         the photo,           │  [ Same as the last one ]     │
 │        as large as fits      │                               │
 │                              │  Where?                       │
 │                              │  [ the dacha in Ratomka     ] │
 │                              │  [ Same as the last one ]     │
 │                              │                               │
 │                              │  Who is in it?                │
 │                              │  (Mama) (Papa) (Aunt Vera) (+)│
 │                              │                               │
 │                              │  Anything you remember?       │
 │                              │  [                          ] │
 │                              │  [                          ] │
 ├──────────────────────────────┴───────────────────────────────┤
 │  [ ← Previous ]        [ I don't know ]        [ Next → ]    │
 └──────────────────────────────────────────────────────────────┘
```

Rules, each one a decision:

- **Big by default.** Minimum 18px text, 48px touch targets, one column of
  questions. Portrait puts the photo above the questions; landscape beside.
  The photo can be tapped to fill the screen and tapped again to come back.
- **When** is a year picker first (a scrolling list, current year at the
  bottom, decades as headings), then an optional month, then an optional day
  that only appears once a month is chosen. Exact/about is a two-way toggle,
  defaulting to *about* when only a year is given. Nothing is typed.
- **Where** is one text box with the last ten distinct answers in this
  delivery offered as chips above it, so "the dacha" is one tap after the
  first time. No map. The geocoder is not offered here.
- **Who** shows the library's people as chips, most-used first, with the ones
  already on this photo filled in. **+** opens a box to type a new name; it
  becomes a person on the People page like any hand-tag.
- **Notes** is a large text box. Keyboard dictation is the tablet's own; a
  microphone of our own is Phase 4.
- **Same as the last one** copies When (all three columns) or Where from the
  previous photo in the sequence, whichever button was pressed. This is the
  single most important control on the page: a box from one summer is one
  tap per photo.
- **Next** saves everything on the screen with one PATCH (plus people calls
  where they changed), marks the photo reviewed, and moves on. **Previous**
  does the same and moves back. **I don't know** marks it reviewed with no
  changes. Leaving the page saves the current photo too. There is no Save.
- Errors are one MessageBox line under the buttons ("Couldn't save that one.
  Try again.") and Next stays on the photo.
- **Done** is a card at the end ("You went through all 38. Thank you.") with
  one button back to Home.

**Getting there.** The `PhotoInboxCard` is shown to anyone with *edit* on an
Inbox, not only delete. It gains `reviewed` and `total`, and its button reads
**Add what you know** for someone who cannot Keep and **Review** for someone
who can (the Inbox page, as today). For the scanner, the Inbox page's delivery
chips show "12 of 38 noted" and the lightbox Info panel shows *Noted by Mama,
Tuesday* under the description.

**Access recipe**, which goes into the user guide: create her account as a
member; open the Inbox library's members dialog; add her as *contributor*.
That is the whole setup. She sees only the Inbox card on Home and the Inbox
under Gallery, and nothing else changes for her.

**Web pieces:** `features/gallery/review/ReviewPage.tsx` (route in `App.tsx`),
`YearPicker.tsx`, `PeopleChips.tsx`; strings in a new `gallery-review`
namespace in `locales/en` and `locales/ru`; a `useReviewQueue` hook over
`GET /api/library/gallery/inbox/:id/items` with a new `unreviewedFirst` order.
No new server routes beyond the Phase 1 fields and one
`POST /api/library/gallery/assets/:id/reviewed` for "I don't know".

## Phase 3 — asking about photos already in the house

Most of the collection is already kept. To ask her about an album of it, **Send
to** on an album gains a checkbox, **Ask for notes**. The recipient's card on
Home reads "Sergey asks: what do you remember about Summer 1971?" and its
button opens Review mode over the album, not the Inbox page. The
`SentCard` carries `askNotes`; the review route takes `/gallery/review/album/:id`.

The permission question is the real work here: she needs *edit* on those items,
and Send to today grants *read* to one item. The clean answer is the same
mechanism at the next role up: "Give access and send" with **Ask for notes** on
grants `contributor` on the album's items, item by item, through the existing
item-level `assignments`. Whether that is acceptable, or whether it should
grant on the library instead, is the first open question below.

## Phase 4 — voice

Two cheap wins, in order:

1. **Dictate into Notes** with the browser's speech API (Chrome on Android,
   Safari on iPad both have it). A microphone button on the Notes box, text
   only, nothing stored but the words. No server change.
2. **A voice note on the photo**: record with `MediaRecorder`, upload into
   `Voice notes/` in the *Made in the app* library as an audio asset, link it
   to the photo through a `gallery_voice_notes (item_id, audio_item_id)` table,
   play it from the lightbox. Everything it needs exists in the story
   recordings flow already; this is the same flow pointed at a photo.

Phase 4 waits until Phase 2 has been used for a real box. If she types happily,
it may never be needed.

## Order and size

| Phase | Depends on | Size |
| --- | --- | --- |
| 0 — fewer spaces | nothing | one setting, three read-through aliases, one Control row, a migration for the copy. Medium. |
| 1 — fields | nothing | migration 70, `edit.ts`, both date modals, lightbox Info, Keep layout by precision, display everywhere dates show. Medium. |
| 2 — Review mode | 1 | one page, three components, card and chip changes, guide. Large. |
| 3 — ask about kept photos | 2 | Send to checkbox, card, permission grant. Small once the open question is settled. |
| 4 — voice | 2 | (1) tiny; (2) medium. |

Ship 1 then 2 first; they are what the box of prints needs. Phase 0 can go in
any release. Phase 3 and 4 wait for use.

## Open questions

1. **Phase 3 grants.** Contributor on each item of an album, or on the library?
   Per item is precise and matches how "give access and send" already works,
   but a person editing three hundred items of one album through three hundred
   grants is odd to look at in the members dialog. Nothing in Phase 1–2 depends
   on the answer.
2. **Year-only photos on the Timeline.** First of the year is honest but piles
   every "1962" onto 1 January. An alternative is a separate *Undated* shelf
   per year at the top of that year. Decide when the first real box is in.
3. **Should "I don't know" be visible to the scanner as a state**, or is
   reviewed-with-no-changes enough? The plan says enough; the Inbox chip count
   does not distinguish. Revisit if the scanner wants to ask someone else.
4. **Whether `place_text` should feed search.** Probably yes, through the
   existing gallery search over description; a one-line change when wanted.

## How it ends

A box goes through the scanner into a delivery folder. Her Home page shows one
card. She taps it and answers what she knows, one photo at a time, tapping
*Same as the last one* far more often than typing. The scanner sees "38 of 38
noted", fixes nothing, and presses Keep; the photos file under the years she
gave, and every story written about them afterwards already knows where and
when they were taken.
