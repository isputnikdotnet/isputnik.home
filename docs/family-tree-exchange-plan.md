# Moving a family tree between servers — plan

Status: **built in code 2026-09-25, uncommitted** — export, Migrate import with
preview, origins, and (beyond phase 3 of this plan) a decision per person and
Replace for packages, both asked for by the owner on 2026-09-25. Code map:
`docs/family-tree.md` → Packages; user guide: `docs/users/family-tree.md` →
"Moving the tree to another isputnik.home server". Written 2026-09-23. The owner
wanted the tree on this server copied to another install (hub, on 4.20.3) that
already has a smaller tree of its own (32 people, 13 families, 11 portraits), and
that tree must not lose anything.

What was built differs from the text below in three places, all decided with the
owner:

- **A decision per person**, in the preview, not only "Don't match": *merge* (fill
  blanks, the default for a match), *use the package's values* (the package wins,
  portrait included), *keep as it is here* (match, change nothing, only connect
  relationships), *add as a new person*, *skip*, and *match with someone here…*
  (a manual match through the person picker). Every change is re-planned on the
  server, so the tally and the matches stay true.
- **Replace is offered for packages** too, as a second mode beside Merge, behind
  the same danger confirmation as the GEDCOM one. Open question 2 below is answered.
- **Portraits carry a sha256**, so a re-import of the same package does not list
  every portrait as a difference; the same-file check on photos uses
  `gallery_details.content_hash` (present only after a duplicate scan) or, for a
  photo this import brought in before, its origin row.

## Why the existing tools don't do it

The tree already has **GEDCOM export/import** (`familytree/gedcom.ts`,
`GedcomImportModal`). GEDCOM is the right format for other genealogy apps, but
it cannot move a tree between two copies of this app:

| Lost in GEDCOM | Where it lives |
| --- | --- |
| Portraits and their crop | `portrait_storage_key`, `portrait_crop_json`, App files copy |
| Photos on a person or a life event | `family_tree_photos`, `family_tree_event_photos` |
| Place pins | `*_lat` / `*_lng` on persons, unions, events |
| Names in other languages | `family_tree_person_names` |
| Branch tags | `taggables` (`family_tree_person`) |
| The person the tree opens on | `app_settings.family_tree_settings` |

Its two import modes don't fit either. **Add** creates everyone again, so the hub
would end up with two of every one of its 32 people. **Replace** deletes the tree
that is already there.

## The package

**Family tree → ⋮ → Export → Full package** downloads
`family-tree-YYYY-MM-DD.zip`:

```
manifest.json      format: "isputnik-family-tree", formatVersion: 1,
                   appVersion, exportedAt, source server id, counts
tree.json          persons (+ otherNames, pins, tags, portrait ref),
                   unions (+ children), events (+ photo refs),
                   sources, citations, settings { defaultPersonId }
media/portraits/<personId>.<ext>      the portrait as shown (cut)
media/portrait-sources/<itemId>.<ext> the photo it was cut from, + crop
media/photos/<itemId>.<ext>           photos on a person or an event
family-tree.ged    the GEDCOM export, for other genealogy apps
```

- Every record carries its **id on the exporting server**. The package's ids are
  never used as row ids on import. They are only for matching (below).
- Photos are **originals**, not thumbnails, so the receiving server can scan
  them, find faces in them and cut portraits again.
- **Not in the package:** the Gallery-person link (`gallery_person_id`, since face
  clusters are per server), branch-editor grants (user accounts are per server),
  activity history. The import report lists these as "not carried over".
- Built as a stream (`archiver`-style zip writer) so a tree with gigabytes of
  photos doesn't go through memory. Admin only, logged
  (`familytree.exported`).

## Import: the migration mode

**Family tree → ⋮ → Import** takes a `.ged` (unchanged) or a package `.zip`. A
package gets a third mode besides Add and Replace, **Migrate**, which is the
default and the one this plan is about. It also works on an empty tree, where
it simply creates everything.

### The rule: nothing already there is overwritten

Migrate only ever **adds**:

| On this server | In the package | Result |
| --- | --- | --- |
| No match | a record | **created** |
| Matched, field empty | a value | **filled in** |
| Matched, field set | same value | nothing to do |
| Matched, field set | a **different** value | **kept as it is**, listed as a *difference* |
| Matched, has a portrait | a portrait | **kept** (listed as a difference) |
| Matched, has no portrait | a portrait | the package's is added |
| A child with parents already | other parents | **kept**, listed as a difference |
| A record | not in the package | **kept**, never touched |

Nothing is deleted and no value that is set is changed, ever. A difference is only
reported, and the admin fixes it by hand if the package was right. (If the owner
wants it, a later version can offer a per-difference "use the package's value"
tick, off by default. See open questions.)

### Matching

A record matches in this order:

1. **Same origin.** A new table `family_tree_origins (entity_type, local_id,
   source_server, source_id)` records, for every record a Migrate created or
   matched, which package record it came from. Importing a newer package from the
   same server finds each record again exactly, with no guessing, even after a
   rename.
2. **People**: same name (case, spacing and punctuation ignored) and the same birth
   date. Failing that, the same name alone when exactly one person on each side
   has it and one side has no birth date. Two people with the same name and
   different dates are never matched (the hub has two Vladimir Posses, born 1864
   and 1924).
3. **Families**: the same two (matched) partners in either order, or a
   single-parent family whose empty partner slot the package fills.
4. **Events**: same person, same type, same date, and the same label/place where
   both have one.
5. **Sources**: same title. **Citations**: same source, target, fact, detail and
   link. A citation is only ever added.
6. **Photos**: the same file (SHA-256 of the original) already in any gallery
   library is reused instead of uploaded twice. Otherwise it goes into App files →
   `Family tree/Imported/<date>`.

`family_tree_origins` is a new table, so no `migrations[]` entry is needed
(schema.sql applies it). Rows cascade away with their record.

### Preview before anything is written

The import runs twice. The first pass is a **dry run** that writes nothing and
opens a preview:

- **Summary:** *42 people added · 30 matched (12 filled in) · 2 new families
  · 14 photos · 3 differences*.
- **Matches:** every matched person side by side ("Anna Posse, 1928, here ↔
  Anna Posse, 1928, package"), with **Don't match** on each, so a wrong guess
  becomes a new person instead of a merge.
- **Differences:** field, value here, value in the package. Read-only in v1.
- **Not carried over:** Gallery links, branch editors.

**Import** (primary) runs the same plan for real in one transaction for the rows.
Files are written first to a staging folder and moved in after the commit, the
way `gallery/upload-routes.ts` stages uploads. The result is the same summary
plus a downloadable report. Logged as `familytree.imported` with the mode.

### The start person

Settings follow the same rule. The package's start person is used only when this
server has none set (or its person was deleted). Otherwise it is a difference.

## Older packages, newer servers

- `formatVersion` is checked first: a newer major version is refused with "This
  package was made by a newer version. Update this server first". A missing
  field in an older one is read as empty.
- The receiving server must be on the release that ships this (hub is on 4.20.3
  today, so it upgrades first).

## Where the code goes

- `modules/familytree/package/export.ts`: builds `tree.json` + streams the zip.
- `modules/familytree/package/import-plan.ts`: parses, matches, and returns the
  plan (pure, and the dry run is exactly this).
- `modules/familytree/package/import-apply.ts`: writes a plan (rows in one
  transaction, then files; portraits through `setUploadedPortraitFile`, photos
  through `scanSingleGalleryFile`, one at a time through `renderInTurn`).
- Routes: `GET /api/family-tree/export/package`, `POST
  /api/family-tree/import/package?dryRun=1` (multipart, admin; the upload is
  kept for the confirming call under a token that expires).
- Web: `GedcomImportModal` becomes `FamilyImportModal` (file → preview → result,
  `shared/Modal` panel); the export menu gains *Full package*. All strings in
  `family` locale keys, en + ru.
- Docs: a section in the family tree user guide.

## Tests

- Round trip: export → import into an empty tree gives the same tree (counts,
  fields, pins, names, portraits, photos, start person).
- Migrate into a tree that shares people: nothing set is changed, blanks are
  filled, differences are reported, nothing is deleted (row counts only grow).
- Import the same package twice: the second run adds nothing (origins).
- Same-name people with different dates are not matched; **Don't match** creates
  a new person.
- A child with other parents here keeps them.
- Dry run writes no rows and no files.
- A package with a newer `formatVersion` is refused; a truncated zip fails
  cleanly with nothing written.

## Phases

1. **Export package** (can ship alone: a complete backup of the tree).
2. **Migrate import** with preview, origins table, report.
3. Optional, only if asked: a per-difference "use the package's value" tick.

## Open questions

- Should a difference ever be resolvable in the preview (phase 3), or always by
  hand afterwards?
- Should Replace be offered for packages at all, or stay GEDCOM-only? It is the
  one mode that deletes.
- Photos on a person that are *already* in the receiving server's gallery under
  a different file (re-encoded, resized) won't match by hash and will be
  imported again. Acceptable for v1?
