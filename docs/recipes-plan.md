# Recipes plan — a story kind, not a module

Status: **RELEASED** — phases 1–3 shipped in v3.66.0 (2026-09-05, migration 67),
the guide screenshot in v3.66.1. What remains is the *Later* list below. Builds on the shipped Stories engine
(`apps/server/src/modules/stories/`, `apps/web/src/features/stories/`); nothing
here adds a library type, a scan layout, or a new server module.

Vision: a family recipe is a memory with a method. Who made it, a photo of the
dish, grandma's voice explaining the trick, the person it belongs to on the
family tree — and then the ingredients and the steps. Stories already carry all
of that (media, audio, person, album blocks; covers; favorites; collections;
guest links; the recycle bin), so a recipe becomes the fifth story kind and a
cookbook becomes a story collection. Nothing is built twice.

What this is **not**: a meal planner. No quantity model, no unit conversion, no
serving scaling, no grocery list, no nutrition, no "what can I cook with what I
have". Mealie and Tandoor do that well and it is not what a family media
library is for. The value here is heritage, not kitchen logistics — if a
feature only makes sense while standing at the stove, it does not belong.

Design rules carried over from Stories v2:

- **A kind is a creation template, then a story.** `stories.kind` is
  app-enforced and the schema comment already promises "a future kind needs no
  schema change". A recipe seeds its chapters and blocks once in `createStory`
  and is an ordinary story from then on — the editor allows everything, the
  reader shows everything, permissions do not care.
- **Structure is prose, not fields.** Ingredients are a text block with a
  heading, one line per item, in Markdown. Steps are text blocks under a
  chapter. The one schema addition (phase 2) is two small facts for the head,
  and it is optional.
- **Collections are cookbooks.** No new grouping concept. "Grandma's kitchen"
  is a story collection holding recipe stories, with the same access rules,
  cover, and ordering collections have today.
- **Everything skippable, nothing blocking.** As with every kind, the New story
  dialog asks only what shapes the start; every answer can be left blank.
- **Strings are keys.** Stories are a swept file: new copy goes to
  `apps/web/src/locales/en/stories.json` and is mirrored in `ru/`.

---

## Phase 1 — The kind (no schema change) — **DONE**

**Server** (`modules/stories/stories.ts`, `routes.ts`)

- `STORY_KINDS` gains `"recipe"`. The zod schemas in `routes.ts` pick it up
  through the enum.
- `createStory` seeds the recipe template inside the existing transaction, in
  the same spirit as the journal's Day 1…N and the review's book card:
  - `chapter_noun` stays `NULL` (chapters are titled, not numbered).
  - Chapter 1 titled *Ingredients*, holding one empty `text` block.
  - Chapter 2 titled *Method*, holding one empty `text` block.
  - Chapter 3 titled *Notes*, holding one empty `text` block — where the story
    part usually lands: whose recipe it was, when it was cooked, what to
    change next time.
  - `opts.place` and `opts.date` continue to land on chapter 1 exactly as
    they do for a memory (a recipe from *Vitebsk, 1978* is a legitimate thing
    to record).
- The chapter titles are seeded as **English text** at creation, like every
  other seeded value. They are ordinary chapter titles the author can rename,
  and `chapter_noun` is not touched. (Seeding in the requester's UI language
  would need the locale on the request; not worth it for three words the
  author will see immediately and can edit.)

**Web**

- `NewStoryModal.tsx`: a fifth `story-kind-option` with the ChefHat icon
  (lucide). Shows the date and place fields (the memory set), nothing
  recipe-specific yet.
- `StoriesSectionNav.tsx` and `StoriesPage.tsx`: a `kind-recipe` entry under
  *Kinds* with its count, `/stories?kind=recipe`, so recipes are one click
  from the index and the chip on the card names them.
- `StoryDetailPage.tsx` / the reader: no change. A recipe reads as
  Ingredients → Method → Notes through the existing chapter rail.
- i18n: `stories:kinds.recipe.name` = "Recipe",
  `stories:kinds.recipe.hint` = "Ingredients, method, and the story behind
  it." Plus the seeded chapter titles as keys only if the seeding ever moves
  to the client (it does not in this phase).

**Docs**: `docs/users/stories.md` adds Recipe to the list of kinds with a
paragraph on the three seeded chapters and the cookbook-as-collection idea.
`docs:shots` recaptures the New story dialog (the kind row changed).

**Tests**: `apps/server/test/` — `createStory` with `kind: "recipe"` yields
three titled chapters each with one empty text block; a PATCH renaming
"Ingredients" is accepted like any chapter title; `kind` survives the share
snapshot in `share.ts`.

Done when: a family member can create a recipe, fill three chapters, attach a
photo and a voice note, put it in a "Family cookbook" collection, share it by
guest link, and find it under Kinds → Recipe.

## Phase 2 — Recipe facts on the head (migration 67) — **DONE**

Two small columns so the reader's head can say *Serves 6 · 45 min* the way a
review's head shows its stars and a memory's shows its place. Both optional,
both free of any unit model.

| column          | type / constraint                                        | purpose |
|-----------------|----------------------------------------------------------|---------|
| `servings`      | `TEXT`                                                   | free text: "6", "4–6", "one big pot" |
| `cook_minutes`  | `INTEGER` (range enforced by zod: 1 … 7 days)          | total time, shown as "45 min" / "2 h 10 min" |

Migration 67 adds both columns (no CHECK — `ALTER TABLE ADD COLUMN` and CHECK
constraints are a poor mix in SQLite; the route schema bounds the value); the
same columns are mirrored into `schema.sql` beside `rating`.

- `StoryUpdate` and the PATCH schema accept both; `publicStory` returns them.
- `NewStoryModal.tsx` shows the two fields when the kind is recipe (like the
  book picker for a review). `StoryOverviewPane.tsx` edits them for any story
  that has them or is a recipe.
- `StoryDetailPage.tsx` renders them in the same meta row as span, place and
  stars, joined by the existing separator. `StoryShareView.tsx` gets the same.
  Both go through `RecipeFacts.tsx`, which prefixes "Serves" only when the
  text is a bare number or range — a site's "Makes 12" is shown as written.
- `servings` is free text on purpose. A number invites scaling, and scaling
  invites a quantity model, and that is the meal planner we are not building.

## Phase 3 — Import from a URL — **DONE** (built ahead of the usage gate at the owner's request)

The feature most likely to get relatives adding recipes: paste a link, get a
draft. Most recipe sites publish schema.org `Recipe` as JSON-LD, so the parser
is small and the fetch already has a safe path.

- Server: `POST /api/stories/import-recipe` `{ url }` (`modules/stories/recipe-import.ts`)
  → `fetchTextFromUrl` over `core/safe-fetch.ts` (SSRF-pinned, size-capped,
  IPv4-first — the same door the remote-image and provider paths use; 3 MB cap).
  Parses every `<script type="application/ld+json">` block that parses, finds
  the first node whose `@type` is or contains `Recipe` (top level, `@graph`,
  or nested), and returns
  `{ title, description, ingredients: string[], steps: string[], servings, cookMinutes, imageUrl, sourceUrl }`.
  ISO-8601 durations (`PT1H30M`) become minutes; no `totalTime` → prep + cook.
  `recipeInstructions` may be a string, strings, `HowToStep` objects, or
  `HowToSection` groups — all flattened, a section's name kept as its own
  line. Text fields are tag-stripped and entity-decoded.
- Creation, not patching: the dialog sends what it read as `recipe` on the
  ordinary `POST /api/stories`, and `createStory` seeds the three chapters
  with it in the same transaction — ingredients as one Markdown list, one text
  block per step (so a photo can go between steps), the source linked from
  Notes. A story never exists half-imported.
- Nothing is fetched into the library. The dish image is **not** downloaded
  and not shown either: the enforced CSP `img-src` allowlist covers known
  metadata providers, not arbitrary recipe sites, and proxying it would reopen
  the remote-image path we deliberately closed. The response carries
  `imageUrl` only so it can be linked from *Notes*; the author picks a real
  cover from their own photos of the dish. Rights stay with the author's
  choices.
- Web: the New story dialog, kind = recipe, gains a *From a link* field with
  a **Read the page** button (Enter works too). Success fills whatever is
  still blank — title, subtitle from the description, serves, time — never
  overwriting what the author typed, and shows a success `MessageBox`
  counting ingredients and steps. Failure is an error `MessageBox` ("Unable
  to read that page") and the author carries on by hand; the link never
  blocks creation.
- Rate-limited (10/min per client) like the other outbound fetchers, and
  admin-toggleable in Control → Settings → Stories
  (`recipeImportEnabled` in `modules/stories/settings.ts`, default on; the
  route answers 403 and the dialog hides the field when off). Findable from
  Control search ("recipe import").
- Tests: `apps/server/test/recipe-import.test.ts` — the three
  `recipeInstructions` shapes, an `@graph` wrapper with a list `@type`, a
  malformed block beside a good one, a page with no JSON-LD, quoted/attributed
  script tags, duration parsing, and a loopback URL refused by the safe
  fetcher; `stories.test.ts` covers the seeded chapters from a seed.

## Later, only with usage

- **Print view.** A reader-only `/stories/:id?print=1` layout: head, ingredients,
  method, no rail, no chrome. The one recipe feature that is legitimately about
  the stove, and cheap. Not before phase 2 exists to put facts on the page.
- **Cookbook guest link.** A collection-level share so one link opens the
  whole book. Already noted in `stories-v2-proposal.md` as "a later option";
  recipes are the first kind that makes it worth doing.
- **Home feed.** "Cook this again" from a recipe's chapter date anniversary,
  through the existing on-this-day idea in the Phase-5 stories list. Same
  gate, same idea, nothing recipe-specific.
- **Person profile.** The family tree person page listing recipes attributed
  to them, once `person` blocks are queried from that side (the quotes plan
  phase 4 builds that join; recipes ride on it).

## Explicitly rejected

- A `recipes` module, table, or library type. Duplicates chapters, blocks,
  covers, sharing, bin, collections, and the index for no gain.
- A scan layout for recipe files on disk. Recipes are authored, not scanned.
- Structured ingredients (quantity, unit, item). The door to scaling and
  shopping lists; closed on purpose.
- Tags as categories ("soup", "dessert"). Story tags already exist and work
  for this; nothing new needed.
