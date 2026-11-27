# Scene search plan

*2026-11-26. Status: proposed, nothing built.*

Type "hockey" into Gallery search and get the photos that show hockey, with nobody
having tagged them. This plan covers that feature in detail and shapes its base so
that two later projects reuse it: OCR, and a document library in the manner of
Paperless.

## How it works

A CLIP-style model turns a photo into a vector of 512 numbers, and turns a typed
phrase into a vector in the same space. Photos whose vectors lie closest to the
phrase's are the results. There is no list of categories: any phrase works, with
varying success, and results are ranked rather than matched.

## Who does what

| Piece | Where | Why |
|---|---|---|
| The model, image → vector, text → vector | the faces container (`isputnik.faces`) | it already runs ONNX models, is stateless, and answers one request at a time |
| Scan pass, stored vectors, the search itself, access rules | home | home owns all data; the engine keeps nothing, as today |
| Search box and results | Gallery | one search box, not a second page |
| Switch, progress, rescan | Control panel › Applications › Gallery › Settings | an application's own control |

The container keeps its name. Its description changes to say it recognises faces
and what photos show. No new container, no new pairing, no backup card: the engine
still holds no data.

## Decisions

1. **One engine, not a second container.** A split is possible later because home
   only speaks HTTP to it; nothing today needs it.
2. **English queries first.** A multilingual model is two to three times larger.
   The vectors carry their model's id, so a later switch re-embeds on the next
   scan, exactly as a face-model change does.
3. **The model ships in the engine's image**, fetched at build from a release
   asset and pinned by SHA-256, like `w600k_r50.onnx`. Downloading on first use
   would give a stateless engine a data volume and a setting; the cost of baking
   it in is a larger image for people who only want faces. *Owner's call.*
4. **Home sends a thumbnail, not the original.** The model looks at 224 × 224
   pixels, so the original's megabytes buy nothing. To confirm in S2: which stored
   rendition is closest to that size.
5. **No vector database.** A family library is small enough to compare a query
   against every vector in memory. Vectors are stored as 8-bit values (512 bytes a
   photo, about 50 MB per 100,000 photos) so home's memory stays modest; S0 checks
   that this costs no visible ranking quality against 32-bit.
6. **Access is applied by the existing catalog query.** Scene search produces
   ranked candidate ids from the libraries the person can see; those ids then go
   through the same scope, person-grant and folder-lock filtering as any Gallery
   list. Scene search never returns rows on its own authority.
7. **The scan pass is generic.** One marker table for "model X has seen item Y",
   keyed by pass name, so OCR is a second pass and not a second pipeline. The face
   scan stays as it is; it is not moved onto the new table.
8. **Engine first, then home.** Home against an older engine says "update the
   faces container" on the settings card and scans nothing.

Open for the owner: decision 3, and whether Photo Inbox and personal libraries are
embedded. The face scan skips both; the proposal is to skip the Inbox and include
personal libraries, since results are filtered by access anyway.

## Phases

### S0. Pick the model (engine repo, a script, nothing shipped)

Candidates, all runnable on the ONNX runtime the engine already has:

- OpenAI CLIP ViT-B/32: the common default, MIT licence, 512 numbers per photo.
- SigLIP base: usually better ranking, larger.
- A MobileCLIP variant: faster on a CPU; licence to be read before use.

Measure on the owner's hardware: photos per second, memory while loaded, file
size, and ranking quality on about thirty real queries against a real library
("hockey", "birthday cake", "snow", "beach", "dog", …). Also from this run: the
similarity cutoff below which results are noise, and the 8-bit check from
decision 5. Every figure quoted before this phase is an estimate.

#### First run, 2026-11-26 (developer PC)

`isputnik.faces`, branch `bench/scene-models`, `bench/scene/bench.mjs`. 317 demo
photos as 512 px thumbnails, one at a time, ONNX runtime capped at four threads
on an i7-12700K (the server's i5-7500 will be slower). One run, 20 queries, three
of them for things not in the photos.

| Model | Photos/s | Query | Memory, image side / both | Files | Numbers per photo |
|---|---|---|---|---|---|
| CLIP ViT-B/32 | 31 | 5 ms | 0.87 / 1.3 GB | 335 + 242 MB | 512 |
| CLIP ViT-B/32, 8-bit | 28 | 5 ms | 0.33 / 0.45 GB | 85 + 62 MB | 512 |
| CLIP ViT-B/16 | 3.9 | 9 ms | 0.81 / 1.2 GB | 329 + 242 MB | 512 |
| SigLIP base | 3.8 | 80 ms | 0.85 / 1.6 GB | 355 + 421 MB | 768 |
| SigLIP base, 8-bit | 6.5 | 46 ms | 0.33 / 0.53 GB | 95 + 106 MB | 768 |

- **Ranking: SigLIP is visibly better.** "A cat" gives eight cats in eight; "hockey"
  (no hockey in the set) gives the field-sport photos. CLIP B/32 finds the obvious
  scenes (astronauts, food, churches, mountains) but pads most rows with blank or
  featureless frames, and for "hockey" returns nothing related.
- **Cutoff: CLIP has none.** Its best score for a thing that is present (0.25–0.30)
  overlaps its best score for a thing that is absent (0.26–0.27). SigLIP separates
  better (present 0.07–0.14, absent 0.03–0.08) and was trained to give a
  yes/no probability, which is the basis for a principled cutoff.
- **Speed is the price:** about eight times slower. At 3.8 photos a second,
  100,000 photos is roughly seven hours here, more on the server, spread over
  nightly three-hour runs. It is paid once; new photos cost a quarter second each.
- **MobileCLIP is excluded:** its weights carry Apple's research licence.
- **8-bit storage** kept 85–92% of each query's top 20. Not yet settled; 16-bit
  (twice the size) is the fallback.

- **SigLIP's 8-bit build is the pick so far.** Against the full model it is 1.7
  times faster, uses a third of the memory and a quarter of the disk, and its
  result sheets look the same: on average six of each query's top eight are the
  same photos, the rest are swaps among near-equal ones, and scores moved by
  about 0.01. At 6.5 photos a second, 100,000 photos is a little over four hours
  on this PC.

Leaning SigLIP base, 8-bit. Still to do: the same run on the server against a real
library, and the cutoff from that run.

### S1. Engine 0.2.0

*Built 2026-11-26 on `isputnik.faces` branch `feat/scene-search`: not committed,
not released, the image not built. Typecheck, lint and 25 tests pass.*

As built, where it differs from the list below or adds to it:

- Model id `siglip-base-patch16-224-q8/1`, 768 numbers per vector. The id covers
  the weights and how input is prepared (resize, prompt).
- **The engine prepares the text**: lower case, punctuation dropped, wrapped as
  "a photo of …". Home sends what was typed, unchanged.
- Tokenizer: `@huggingface/tokenizers` (pure JS, no dependencies). Its output and
  the text vectors match the benchmark's reference exactly.
- The image and text models load apart and each leaves memory after ten idle
  minutes. Measured: 260 MB with the image side loaded, 400 MB with both.
- The engine shrinks pictures with smoothing; the benchmark's reference did not.
  Ranking over the 317 photos is equivalent (6.1 of each top 8 shared), with
  scores for things present slightly higher and for things absent slightly lower.
- **Speed here was 4.7 photos a second**, not the benchmark's 6.5, on a newer
  onnxruntime. Not investigated.
- 8-bit image vectors shift slightly between onnxruntime versions (0.995 alike
  for the same pixels). Harmless for ranking; a runtime upgrade does not need a
  re-embed.
- The model is fetched at image build from a pinned upstream revision on Hugging
  Face, each file checked by SHA-256 (`scripts/fetch-scene-model.mjs`). The face
  model comes from the owner's own GitHub release; mirroring this one there too
  would remove the build's dependence on Hugging Face. *Owner's call.*
- What was typed is never logged or recorded by the engine.

- `POST /faces/api/embed/image`: image bytes in, `{ model, embedding }` out.
  Signed, admin, in the same one-at-a-time turn as `/detect`.
- `POST /faces/api/embed/text`: `{ text }` in, `{ model, embedding }` out.
- `GET /faces/api/health` gains `scene: { model, present, loaded }`.
- A tokenizer for the chosen model. The engine has none today; this is the one
  piece with no counterpart in the face code.
- The scene model loads on first use and unloads after an idle period, so an
  install that only uses faces pays no memory for it.
- `scripts/fetch-scene-model.mjs`, Dockerfile stage, tests against a fixture.

### S2. Home: scan and store

*Built 2026-11-26 on branch `preview/scene-search` (worktree
`.claude/worktrees/scene-search`), not committed. Typecheck, `check:ui`, lint and
the server suite pass; run for real against the demo libraries (319 photos
described through the engine, about 4 a second).*

As built, where it differs from the list below or adds to it:

- **One switch for the whole install**, not one per library as faces have: a
  vector names nobody and is shown to nobody. Every gallery library a person made
  is described, personal ones included; the Photo Inbox and App files are not.
- **One job per library**, not numbered batches of 1,000: the job's own progress
  says how far it is. Job type `SCAN_GALLERY_SCENES`, under the one-at-a-time lock.
- **Input is the 400 px thumbnail** the gallery scan already made
  (`item_metadata.cover_storage_key`). A photo without one is retried three
  times, then left until a full rescan.
- **Vectors are stored 8-bit, each scaled to its own largest value**
  (`scene/vectors.ts`): 768 bytes a photo. A search over them returns 97.7% of
  the same top 20 as over the full vectors; one fixed scale for all kept 94%.
- The nightly task ("Describe new photos for search", 05:30) queues behind a
  running scan instead of skipping the night, since the face scan is usually
  still going at that hour.
- Switching off stops a running scan at its next photo and keeps what was
  described; "Delete search data" is offered only once it is off.
- Its page is Applications › Gallery › **Search by content**
  (`/control/apps/gallery/scene-search`), a page under the Overview, with a row
  for it in the Overview's Features list.
- The shared engine client was not split out: `scene/engine-client.ts` reuses
  the gateway signing and the faces client's system identity, nothing more.
- **Found while running it: the engine must cap the scene model's threads.** On
  a 20-thread desktop it took 1.7 s a photo with 19 threads and 0.2 s with 4.
  The engine now caps it at 4 (`MAX_THREADS` in `src/scene.ts`).
- Not done: the guide, screenshots, and `docs/users/`; they wait for S3, when
  there is a search to show.

- `schema.sql`: `item_model_scans (item_id, pass, model, status, attempts,
  scanned_at)` and `gallery_scene_vectors (item_id, model, vector)`. New tables
  only, so no migration; run `npm run db:rows` after.
- `gallery/scene/`: `engine-client.ts`, `queue.ts`, `scanner.ts`, `settings.ts`,
  following `gallery/faces/`: batches of 1,000 in the `jobs` table, a bounded
  retry count for photos that fail, the three-hour nightly time box, "engine not
  answering" skips the batch instead of failing every photo.
- The engine client's shared parts (signing, health, error kinds) move out of
  `faces/engine-client.ts` so both passes use one.
- Runs after the face scan in the nightly chain, never beside it.
- Settings card in the Gallery workspace: switch, engine status, progress,
  "Scan again". Terms in `search-index.ts`; strings in `en/` and `ru/`.
- Tasks page shows the job under `?application=gallery`.

### S3. Home: search

*Built 2026-11-26 on the same branch, not committed. Checks as for S2; tried in
the browser on the 319 demo photos ("a cat" finds the five cats, "mountains" ten
landscapes, "birthday cake" nothing).*

As built, where it differs from the list below or adds to it:

- `POST /api/library/gallery/scene/search`, for anyone signed in, with the
  Timeline's own body (words, kinds, filters). It answers `available: false`
  instead of an error when the feature is off or the engine is away.
- **The section sits ABOVE the name matches**, not under them: with paged name
  matches, a section below would never be seen, and most content words match no
  file or folder name at all. It shows twelve photos with "Show all (N)", then
  "Matched by name" over the dated photos. Timeline view only.
- **The filters that are on apply** (libraries, kinds, people, tags, dates, …):
  ranked candidates pass through `galleryAssetIdsPassing`, the Timeline's own
  scope and filter clauses, then `getGalleryAssets`.
- **Photos shared by person from a library the asker cannot open are not
  found.** Vectors are read only for libraries in the browsing scope.
- **Cutoff, provisional:** score at least 0.06, at least 60% of the best hit, at
  most 120 photos (`scene/search.ts`). On the demo photos a floor of 0.05 let
  "a dog" find two photos with no dog in them; 0.06 fixes that, but the nonsense
  word "asdf" still finds three. To be set again on a real library.
- A search takes about 60 ms here, most of it the engine turning the words into
  a vector; repeated words are remembered. A library's vectors stay in memory
  for ten minutes after the last search.
- Not done: "similar photos", video clips, the guide and screenshots (S4).

- `GET` search route: text → engine → vector (small cache of recent queries) →
  compare against the cached vectors of visible libraries → ids above the cutoff,
  best first, capped → through the catalog query (decision 6).
- Gallery search results gain a second section under the existing name matches:
  photos that look like the phrase, best first. Layout to be settled in the
  browser; it must not add a second row of views.
- The section is absent when the feature is off or the engine is down; the name
  search never depends on the engine.
- Tests: a member never sees a photo from a library, person grant or locked folder
  they cannot open, whatever its score.

### S4. Ship

Guide in `docs/users/` and its Help entry, `docs:shots` with demo photos only,
changelog, engine release, then home release. Descriptions updated on GitHub,
ghcr, Docker Hub and the Unraid template.

## Later, on the same base

- **Similar photos.** "More like this" in the lightbox: the same comparison with a
  photo's own vector as the query. Small.
- **Video clips.** Embed the poster frame, or a few frames.
- **Better duplicate detection** from the same vectors.

## OCR and the document library

Planned for, not scheduled. What this plan leaves ready for them:

- The generic marker table (`pass = 'ocr'`), the scan-pass pattern, the shared
  engine client, and the engine's load-on-use model handling.

What they add:

- **Engine:** an `/ocr` endpoint returning text and its position on the page.
  Model to be chosen then. Two routes: ONNX text detection and recognition models
  on the runtime already in the engine, or Tesseract as a native program, which is
  what Paperless uses and which can also write a searchable PDF. Cyrillic support
  is a requirement at that point, unlike here.
- **Home:** `item_text (item_id, source, text)` with an SQLite full-text index
  over it. The server has no full-text index today. Gallery search then also finds
  words in photos and on the backs of prints.
- **Document library:** a media type in home at `modules/library/document/` with
  an `APPLICATIONS` entry, not a container. Intake folder like the Photo Inbox;
  date, sender and type per document; existing tags and collections; the PDF
  viewer the ebook reader has. PDFs that already carry their text need no OCR,
  only extraction. Guessing sender and type from the text can wait.

Scene search and OCR do not depend on each other; either can be built first once
S2's base exists.
