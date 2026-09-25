// Writing an import plan (import-plan.ts). Rows go in one transaction; then the
// media — portraits into the thumbnail store, photos into App files → Family tree
// → Imported, one file at a time (a sharp pipeline per file; two at once can kill
// the process, shared/thumbnail.ts) — and the attachments that need those items.
// A crash between the two leaves a complete tree without some of its pictures,
// which the next import of the same package fills in (origins).
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { FAMILY_PERSON_ENTITY_TYPE } from "../access.js";
import { isAncestorOf } from "../persons.js";
import { attachFamilyEventPhotos, attachFamilyPhotos } from "../photos.js";
import { setFamilyTreeSettings } from "../settings.js";
import { addEntityTags } from "../../library/shared/tagging.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../../library/shared/thumbnail.js";
import { validateLibrarySource } from "../../library/shared/library-source.js";
import { normaliseRelativePath } from "../../library/shared/storage-roots.js";
import { getHouseLibrary, HOUSE_FOLDERS } from "../../library/gallery/house-library.js";
import { uniqueGalleryFileName } from "../../library/gallery/files.js";
import { scanSingleGalleryFile } from "../../library/gallery/scanner.js";
import { extractFromZip } from "../../backups/zip-read.js";
import type { ImportPlan, ImportSummary } from "./import-plan.js";
import type { FamilyTreePersonRow } from "../../../db/rows.js";

/** The folder under App files → Family tree that imported photos land in. */
export const IMPORTED_FOLDER = "Imported";

export interface ImportResult {
  mode: ImportPlan["mode"];
  summary: ImportSummary;
  warnings: string[];
}

interface IdMaps {
  persons: Map<string, string>;
  unions: Map<string, string>;
  events: Map<string, string>;
  sources: Map<string, string>;
  photos: Map<string, string>;
}

/** Move a staged file into a library. The data folder and a library are often
 *  on different disks (EXDEV), where a rename cannot cross; copy then. */
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

const clip = (value: string | null | undefined, max: number): string | null => {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
};

// Zip entry names are our own (format.ts), but a hand-made package is still a
// file from outside: only the two media folders, one flat name each.
const MEDIA_ENTRY = /^media\/(portraits|photos)\/[A-Za-z0-9_-]{1,64}\.[a-z0-9]{1,6}$/;

/** Write the plan. `packagePath` is the uploaded zip, `stagingDir` a folder of
 *  this import's own for the media, removed when done. */
export async function applyImportPlan(
  plan: ImportPlan,
  packagePath: string,
  stagingDir: string,
  userId: string
): Promise<ImportResult> {
  const warnings = [...plan.preview.warnings];
  const summary: ImportSummary = { ...plan.preview.summary, photosImported: 0, portraitsSet: 0, childrenLinked: 0, citationsCreated: 0 };
  const maps: IdMaps = { persons: new Map(), unions: new Map(), events: new Map(), sources: new Map(), photos: new Map() };
  const removedPortraitKeys: string[] = [];
  const now = () => new Date().toISOString();

  const origin = db.prepare(`
    INSERT INTO family_tree_origins (entity_type, local_id, source_server, source_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(entity_type, local_id) DO UPDATE SET source_server = excluded.source_server, source_id = excluded.source_id, imported_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ON CONFLICT(entity_type, source_server, source_id) DO UPDATE SET local_id = excluded.local_id, imported_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  const remember = (type: string, localId: string, sourceId: string) => origin.run(type, localId, plan.sourceServer, sourceId);

  db.transaction(() => {
    if (plan.mode === "replace") {
      const keys = db.prepare("SELECT portrait_storage_key AS key FROM family_tree_persons WHERE portrait_storage_key IS NOT NULL")
        .all() as { key: string }[];
      removedPortraitKeys.push(...keys.map((r) => r.key));
      db.prepare(`DELETE FROM taggables WHERE entity_type = '${FAMILY_PERSON_ENTITY_TYPE}' AND entity_id IN (SELECT id FROM family_tree_persons)`).run();
      summary.personsRemoved = db.prepare("DELETE FROM family_tree_persons").run().changes;
      db.prepare("DELETE FROM family_tree_sources").run();
      // Photo origins stay: the gallery items are still here to be reused.
      db.prepare("DELETE FROM family_tree_origins WHERE entity_type IN ('person', 'union', 'event', 'source')").run();
    }

    // Sources first: citations point at them.
    const insertSource = db.prepare("INSERT INTO family_tree_sources (id, title, author, publisher, url, note) VALUES (?, ?, ?, ?, ?, ?)");
    for (const op of plan.sources) {
      if (op.kind === "link") { maps.sources.set(op.pkgId, op.localId); remember("source", op.localId, op.pkgId); continue; }
      const id = nanoid(16);
      insertSource.run(id, clip(op.pkg.title, 300) ?? "Untitled source", clip(op.pkg.author, 200), clip(op.pkg.publisher, 300), clip(op.pkg.url, 1000), clip(op.pkg.note, 2000));
      maps.sources.set(op.pkg.id, id);
      remember("source", id, op.pkg.id);
    }

    const insertPerson = db.prepare(`
      INSERT INTO family_tree_persons (id, name, maiden_name, gender, birth_date, death_date, deceased, birthplace, death_place,
        birth_lat, birth_lng, death_lat, death_lng, bio, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertName = db.prepare("INSERT INTO family_tree_person_names (person_id, position, language, name) VALUES (?, ?, ?, ?)");
    const nextNamePosition = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM family_tree_person_names WHERE person_id = ?");
    const addNames = (personId: string, names: { language: string; name: string }[]) => {
      let position = (nextNamePosition.get(personId) as { next: number }).next;
      for (const n of names) {
        const language = n.language.trim().slice(0, 16);
        const name = n.name.trim().slice(0, 120);
        if (!language || !name) continue;
        insertName.run(personId, position, language, name);
        position += 1;
      }
    };
    for (const op of plan.persons) {
      if (op.kind === "create") {
        const p = op.pkg;
        const id = nanoid(16);
        insertPerson.run(
          id, clip(p.name, 120) ?? "Unknown", clip(p.maidenName, 120), p.gender ?? "unknown",
          p.birthDate || null, p.deathDate || null, p.deceased ? 1 : 0,
          clip(p.birthplace, 200), clip(p.deathPlace, 200),
          p.birthPin?.lat ?? null, p.birthPin?.lng ?? null, p.deathPin?.lat ?? null, p.deathPin?.lng ?? null,
          clip(p.bio, 4000), userId
        );
        addNames(id, p.otherNames ?? []);
        if (p.tags && p.tags.length > 0) addEntityTags(FAMILY_PERSON_ENTITY_TYPE, id, p.tags);
        maps.persons.set(p.id, id);
        remember("person", id, p.id);
        continue;
      }
      maps.persons.set(op.pkg.id, op.localId);
      remember("person", op.localId, op.pkg.id);
      if (op.kind === "link") continue;
      const sets = Object.entries(op.fields);
      if (sets.length > 0) {
        db.prepare(`UPDATE family_tree_persons SET ${sets.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
          .run(...sets.map(([, value]) => value), now(), op.localId);
      }
      if (op.otherNames.length > 0) addNames(op.localId, op.otherNames);
      if (op.tags.length > 0) addEntityTags(FAMILY_PERSON_ENTITY_TYPE, op.localId, op.tags);
    }

    const insertUnion = db.prepare(`
      INSERT INTO family_tree_unions (id, person1_id, person2_id, status, married_date, married_place, married_lat, married_lng, divorced_date, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const op of plan.unions) {
      const u = op.pkg;
      if (op.kind === "link") { maps.unions.set(u.id, op.localId); remember("union", op.localId, u.id); continue; }
      if (op.kind === "fillPartner") {
        const partner = maps.persons.get(op.partnerPkgId);
        if (partner) {
          db.prepare("UPDATE family_tree_unions SET person2_id = ?, updated_at = ? WHERE id = ? AND person2_id IS NULL").run(partner, now(), op.localId);
          // The marriage facts follow the same rule as a person's fields: blanks fill.
          db.prepare(`
            UPDATE family_tree_unions SET
              status = CASE WHEN status = 'unknown' THEN ? ELSE status END,
              married_date = COALESCE(married_date, ?), married_place = COALESCE(married_place, ?),
              married_lat = COALESCE(married_lat, ?), married_lng = COALESCE(married_lng, ?),
              divorced_date = COALESCE(divorced_date, ?), note = COALESCE(note, ?)
            WHERE id = ?
          `).run(u.status ?? "unknown", u.marriedDate || null, clip(u.marriedPlace, 200), u.marriedPin?.lat ?? null, u.marriedPin?.lng ?? null, u.divorcedDate || null, clip(u.note, 1000), op.localId);
        }
        maps.unions.set(u.id, op.localId);
        remember("union", op.localId, u.id);
        continue;
      }
      const p1 = maps.persons.get(u.person1Id);
      const p2 = u.person2Id ? maps.persons.get(u.person2Id) ?? null : null;
      if (!p1) continue;
      const id = nanoid(16);
      insertUnion.run(id, p1, p2, u.status ?? "unknown", u.marriedDate || null, clip(u.marriedPlace, 200), u.marriedPin?.lat ?? null, u.marriedPin?.lng ?? null, u.divorcedDate || null, clip(u.note, 1000));
      maps.unions.set(u.id, id);
      remember("union", id, u.id);
    }

    const insertChild = db.prepare("INSERT OR IGNORE INTO family_tree_children (union_id, child_id, relation) VALUES (?, ?, ?)");
    const hasParents = db.prepare("SELECT 1 FROM family_tree_children WHERE child_id = ?");
    const unionRow = db.prepare("SELECT person1_id, person2_id FROM family_tree_unions WHERE id = ?");
    for (const op of plan.children) {
      const unionId = maps.unions.get(op.unionPkgId);
      const childId = maps.persons.get(op.childPkgId);
      if (!unionId || !childId) continue;
      if (hasParents.get(childId)) continue;
      const parents = unionRow.get(unionId) as { person1_id: string; person2_id: string | null } | undefined;
      if (!parents) continue;
      const partners = [parents.person1_id, parents.person2_id].filter((id): id is string => id != null);
      if (partners.includes(childId) || partners.some((parent) => isAncestorOf(childId, parent))) {
        warnings.push(`A parent–child link was skipped: it would make someone their own ancestor.`);
        continue;
      }
      summary.childrenLinked += insertChild.run(unionId, childId, op.relation).changes;
    }

    const insertEvent = db.prepare(`
      INSERT INTO family_tree_events (id, person_id, type, label, date, end_date, place, place_lat, place_lng, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const op of plan.events) {
      const e = op.pkg;
      if (op.kind === "link") { maps.events.set(e.id, op.localId); remember("event", op.localId, e.id); continue; }
      const personId = maps.persons.get(e.personId);
      if (!personId) continue;
      const id = nanoid(16);
      insertEvent.run(id, personId, e.type, clip(e.label, 120), e.date || null, e.endDate || null, clip(e.place, 200), e.placePin?.lat ?? null, e.placePin?.lng ?? null, clip(e.note, 2000));
      maps.events.set(e.id, id);
      remember("event", id, e.id);
    }

    const insertCitation = db.prepare(`
      INSERT INTO family_tree_citations (id, source_id, person_id, event_id, union_id, fact, detail, url, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of plan.citations) {
      const sourceId = maps.sources.get(c.sourceId);
      const personId = c.personId ? maps.persons.get(c.personId) ?? null : null;
      const eventId = c.eventId ? maps.events.get(c.eventId) ?? null : null;
      const unionId = c.unionId ? maps.unions.get(c.unionId) ?? null : null;
      if (!sourceId || [personId, eventId, unionId].filter(Boolean).length !== 1) continue;
      insertCitation.run(nanoid(16), sourceId, personId, eventId, unionId, c.fact ?? null, clip(c.detail, 500), clip(c.url, 1000), clip(c.note, 2000));
      summary.citationsCreated += 1;
    }

    if (plan.defaultPersonPkgId) {
      const id = maps.persons.get(plan.defaultPersonPkgId);
      if (id) setFamilyTreeSettings({ defaultPersonId: id }, userId);
    }
  })();

  for (const key of removedPortraitKeys) {
    await fs.promises.rm(thumbnailAbsolutePath(key), { force: true }).catch(() => {});
  }

  // ── Media ──
  const wanted = new Map<string, string>();
  for (const op of plan.photos) if (!op.localId && MEDIA_ENTRY.test(op.pkg.file)) wanted.set(op.pkg.file, path.join(stagingDir, ...op.pkg.file.split("/")));
  for (const op of plan.portraits) if (MEDIA_ENTRY.test(op.file)) wanted.set(op.file, path.join(stagingDir, ...op.file.split("/")));
  if (wanted.size > 0) {
    try {
      await extractFromZip(packagePath, (entryName) => wanted.get(entryName) ?? null);
    } catch (err) {
      warnings.push(`The package's pictures could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const house = getHouseLibrary();
  let importDir: { root: string; dir: string } | null = null;
  if (house) {
    try {
      const root = validateLibrarySource(house.source_path);
      const dir = path.join(root, HOUSE_FOLDERS.familyTree, IMPORTED_FOLDER, now().slice(0, 10));
      importDir = { root, dir };
    } catch {
      warnings.push("The App files library's folder is unavailable; photos were not imported.");
    }
  }

  for (const op of plan.photos) {
    let itemId = op.localId;
    if (!itemId) {
      const staged = wanted.get(op.pkg.file);
      if (!staged || !fs.existsSync(staged) || !importDir) {
        if (staged && !fs.existsSync(staged)) warnings.push(`Photo "${op.pkg.fileName}" is missing from the package.`);
        continue;
      }
      try {
        fs.mkdirSync(importDir.dir, { recursive: true });
        // The characters no filesystem takes, and control characters, dropped.
        const safeName = Array.from(path.basename(op.pkg.fileName))
          .filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/|?*'.includes(ch) && ch !== String.fromCharCode(92))
          .join("").trim() || `photo${path.extname(op.pkg.file)}`;
        const finalName = uniqueGalleryFileName(importDir.dir, safeName) ?? `${op.pkg.id}${path.extname(op.pkg.file)}`;
        const finalPath = path.join(importDir.dir, finalName);
        moveFile(staged, finalPath);
        itemId = await scanSingleGalleryFile(house!.id, normaliseRelativePath(path.relative(importDir.root, finalPath)));
        if (!itemId) {
          fs.rmSync(finalPath, { force: true });
          warnings.push(`Photo "${op.pkg.fileName}" could not be read and was left out.`);
          continue;
        }
        remember("photo", itemId, op.pkg.id);
        summary.photosImported += 1;
      } catch (err) {
        warnings.push(`Photo "${op.pkg.fileName}" could not be imported: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    } else {
      remember("photo", itemId, op.pkg.id);
    }
    maps.photos.set(op.pkg.id, itemId);
    for (const personPkgId of op.attachPersons) {
      const personId = maps.persons.get(personPkgId);
      if (personId) attachFamilyPhotos(personId, [itemId], userId);
    }
    for (const eventPkgId of op.attachEvents) {
      const eventId = maps.events.get(eventPkgId);
      if (eventId) attachFamilyEventPhotos(eventId, [itemId], userId);
    }
  }

  for (const op of plan.portraits) {
    const personId = maps.persons.get(op.personPkgId);
    const staged = wanted.get(op.file);
    if (!personId || !staged || !fs.existsSync(staged)) {
      if (personId) warnings.push(`The portrait of a person is missing from the package.`);
      continue;
    }
    try {
      const previous = db.prepare("SELECT portrait_storage_key FROM family_tree_persons WHERE id = ?").get(personId) as Pick<FamilyTreePersonRow, "portrait_storage_key"> | undefined;
      const ext = path.extname(op.file).toLowerCase() || ".jpg";
      const storageKey = thumbnailStorageKey("familytree", personId, `${personId}-portrait-${Date.now()}${ext}`);
      const target = thumbnailAbsolutePath(storageKey);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(staged, target);
      const sourceItem = op.sourcePhotoId ? maps.photos.get(op.sourcePhotoId) ?? null : null;
      db.prepare(`
        UPDATE family_tree_persons
        SET portrait_storage_key = ?, portrait_item_id = ?, portrait_crop_json = ?, portrait_file_item_id = NULL, updated_at = ?
        WHERE id = ?
      `).run(storageKey, sourceItem, op.crop ? JSON.stringify(op.crop) : null, now(), personId);
      if (previous?.portrait_storage_key && previous.portrait_storage_key !== storageKey) {
        await fs.promises.rm(thumbnailAbsolutePath(previous.portrait_storage_key), { force: true }).catch(() => {});
      }
      summary.portraitsSet += 1;
    } catch (err) {
      warnings.push(`A portrait could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });
  return { mode: plan.mode, summary, warnings };
}
