// Building a family-tree package (format.ts): the tree as JSON plus the media a
// rescan on the other side cannot rebuild. The zip is streamed, so a tree with
// gigabytes of photos never sits in memory. Admin only (the route checks).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { nanoid } from "nanoid";
import { ZipArchive } from "archiver";
import { db } from "../../../db.js";
import { config } from "../../../config.js";
import { FAMILY_PERSON_ENTITY_TYPE } from "../access.js";
import { exportGedcom } from "../gedcom.js";
import { getFamilyTreeSettings } from "../settings.js";
import { entityTagsByIds } from "../../library/shared/tagging.js";
import { thumbnailAbsolutePath } from "../../library/shared/thumbnail.js";
import { validateLibrarySource } from "../../library/shared/library-source.js";
import {
  GEDCOM_ENTRY, MANIFEST_ENTRY, PACKAGE_FORMAT, PACKAGE_FORMAT_VERSION, PHOTOS_DIR, PORTRAITS_DIR, TREE_ENTRY,
  type PackageCitation, type PackageEvent, type PackageManifest, type PackagePerson, type PackagePhoto,
  type PackageSource, type PackageTree, type PackageUnion
} from "./format.js";
import type {
  FamilyTreeChildRow, FamilyTreeCitationRow, FamilyTreeEventPhotoRow, FamilyTreeEventRow, FamilyTreePersonNameRow,
  FamilyTreePersonRow, FamilyTreePhotoRow, FamilyTreeSourceRow, FamilyTreeUnionRow, GalleryDetailRow, LibraryRow
} from "../../../db/rows.js";

const SERVER_ID_KEY = "server_id";

/** This install's random id, made the first time it is asked for. It names this
 *  server as the origin of the records in a package it exports. */
export function getServerId(): string {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SERVER_ID_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;
  const id = nanoid(16);
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)").run(SERVER_ID_KEY, id);
  return (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SERVER_ID_KEY) as { value: string }).value;
}

const pin = (lat: number | null, lng: number | null) => (lat != null && lng != null ? { lat, lng } : null);

interface MediaFile {
  /** The path inside the zip. */
  entry: string;
  absolutePath: string;
}

type PhotoRow = Pick<GalleryDetailRow, "item_id" | "kind" | "relative_path" | "taken_at" | "content_hash"> & Pick<LibraryRow, "source_path">;

/** Everything the package holds: the JSON and the files to stream after it.
 *  Files that are missing on disk are left out and named in `warnings`. */
export interface PackageBuild {
  manifest: PackageManifest;
  tree: PackageTree;
  media: MediaFile[];
  warnings: string[];
}

export async function buildPackage(): Promise<PackageBuild> {
  const warnings: string[] = [];
  const media: MediaFile[] = [];

  const personRows = db.prepare("SELECT * FROM family_tree_persons ORDER BY name COLLATE NOCASE, id").all() as FamilyTreePersonRow[];
  const nameRows = db.prepare("SELECT person_id, language, name FROM family_tree_person_names ORDER BY person_id, position")
    .all() as Pick<FamilyTreePersonNameRow, "person_id" | "language" | "name">[];
  const tags = entityTagsByIds(FAMILY_PERSON_ENTITY_TYPE, personRows.map((p) => p.id));
  const personPhotoRows = db.prepare("SELECT person_id, item_id FROM family_tree_photos ORDER BY person_id, position")
    .all() as Pick<FamilyTreePhotoRow, "person_id" | "item_id">[];
  const eventPhotoRows = db.prepare("SELECT event_id, item_id FROM family_tree_event_photos ORDER BY event_id, position")
    .all() as Pick<FamilyTreeEventPhotoRow, "event_id" | "item_id">[];

  // Every gallery item the tree refers to, once. Items that are gone (deleted,
  // or in a library whose folder is unreachable) are dropped from the references.
  const wanted = new Set<string>();
  for (const row of personRows) if (row.portrait_item_id) wanted.add(row.portrait_item_id);
  for (const row of personPhotoRows) wanted.add(row.item_id);
  for (const row of eventPhotoRows) wanted.add(row.item_id);
  const photos = new Map<string, PackagePhoto>();
  if (wanted.size > 0) {
    const ids = [...wanted];
    const rows: PhotoRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      rows.push(...db.prepare(`
        SELECT gd.item_id, gd.kind, gd.relative_path, gd.taken_at, gd.content_hash, libraries.source_path
        FROM library_items li
        JOIN gallery_details gd ON gd.item_id = li.id
        JOIN libraries ON libraries.id = li.library_id
        WHERE li.deleted_at IS NULL AND li.id IN (${slice.map(() => "?").join(", ")})
      `).all(...slice) as PhotoRow[]);
    }
    for (const row of rows) {
      if (row.kind !== "photo" && row.kind !== "video") continue;
      let root: string;
      try { root = validateLibrarySource(row.source_path); } catch { continue; }
      const absolutePath = path.join(root, ...row.relative_path.split("/"));
      if (!fs.existsSync(absolutePath)) {
        warnings.push(`Photo "${path.basename(row.relative_path)}" is missing from its library and was left out.`);
        continue;
      }
      const ext = path.extname(row.relative_path).toLowerCase() || ".jpg";
      const entry = `${PHOTOS_DIR}/${row.item_id}${ext}`;
      photos.set(row.item_id, {
        id: row.item_id,
        file: entry,
        fileName: path.basename(row.relative_path),
        kind: row.kind,
        sha256: row.content_hash ?? await sha256Of(absolutePath),
        takenAt: row.taken_at
      });
      media.push({ entry, absolutePath });
    }
  }
  const photoRef = (itemId: string | null): string | null => (itemId && photos.has(itemId) ? itemId : null);

  const namesByPerson = new Map<string, { language: string; name: string }[]>();
  for (const row of nameRows) {
    const list = namesByPerson.get(row.person_id) ?? [];
    list.push({ language: row.language, name: row.name });
    namesByPerson.set(row.person_id, list);
  }
  const photosByPerson = new Map<string, string[]>();
  for (const row of personPhotoRows) {
    const id = photoRef(row.item_id);
    if (!id) continue;
    const list = photosByPerson.get(row.person_id) ?? [];
    list.push(id);
    photosByPerson.set(row.person_id, list);
  }
  const photosByEvent = new Map<string, string[]>();
  for (const row of eventPhotoRows) {
    const id = photoRef(row.item_id);
    if (!id) continue;
    const list = photosByEvent.get(row.event_id) ?? [];
    list.push(id);
    photosByEvent.set(row.event_id, list);
  }

  const persons: PackagePerson[] = [];
  for (const row of personRows) {
    let portrait: PackagePerson["portrait"] = null;
    if (row.portrait_storage_key) {
      const absolutePath = thumbnailAbsolutePath(row.portrait_storage_key);
      if (fs.existsSync(absolutePath)) {
        const entry = `${PORTRAITS_DIR}/${row.id}${path.extname(row.portrait_storage_key).toLowerCase() || ".jpg"}`;
        media.push({ entry, absolutePath });
        let crop: NonNullable<PackagePerson["portrait"]>["crop"] = null;
        if (row.portrait_crop_json) {
          try { crop = JSON.parse(row.portrait_crop_json) as typeof crop; } catch { crop = null; }
        }
        portrait = { file: entry, sha256: await sha256Of(absolutePath), crop, sourcePhotoId: photoRef(row.portrait_item_id) };
      } else {
        warnings.push(`The portrait of ${row.name} is missing from the thumbnail store and was left out.`);
      }
    }
    persons.push({
      id: row.id,
      name: row.name,
      maidenName: row.maiden_name,
      otherNames: namesByPerson.get(row.id) ?? [],
      gender: row.gender,
      birthDate: row.birth_date,
      deathDate: row.death_date,
      deceased: row.deceased === 1,
      birthplace: row.birthplace,
      deathPlace: row.death_place,
      birthPin: pin(row.birth_lat, row.birth_lng),
      deathPin: pin(row.death_lat, row.death_lng),
      bio: row.bio,
      tags: tags.get(row.id) ?? [],
      portrait,
      photos: photosByPerson.get(row.id) ?? []
    });
  }

  const childRows = db.prepare("SELECT union_id, child_id, relation FROM family_tree_children ORDER BY added_at, child_id")
    .all() as Pick<FamilyTreeChildRow, "union_id" | "child_id" | "relation">[];
  const childrenByUnion = new Map<string, PackageUnion["children"]>();
  for (const row of childRows) {
    const list = childrenByUnion.get(row.union_id) ?? [];
    list!.push({ personId: row.child_id, relation: row.relation });
    childrenByUnion.set(row.union_id, list);
  }
  const unions: PackageUnion[] = (db.prepare("SELECT * FROM family_tree_unions ORDER BY created_at, id").all() as FamilyTreeUnionRow[])
    .map((row) => ({
      id: row.id,
      person1Id: row.person1_id,
      person2Id: row.person2_id,
      status: row.status,
      marriedDate: row.married_date,
      marriedPlace: row.married_place,
      marriedPin: pin(row.married_lat, row.married_lng),
      divorcedDate: row.divorced_date,
      note: row.note,
      children: childrenByUnion.get(row.id) ?? []
    }));

  const events: PackageEvent[] = (db.prepare("SELECT * FROM family_tree_events ORDER BY person_id, date, created_at").all() as FamilyTreeEventRow[])
    .map((row) => ({
      id: row.id,
      personId: row.person_id,
      type: row.type,
      label: row.label,
      date: row.date,
      endDate: row.end_date,
      place: row.place,
      placePin: pin(row.place_lat, row.place_lng),
      note: row.note,
      photos: photosByEvent.get(row.id) ?? []
    }));

  const sources: PackageSource[] = (db.prepare("SELECT * FROM family_tree_sources ORDER BY title COLLATE NOCASE, id").all() as FamilyTreeSourceRow[])
    .map((row) => ({ id: row.id, title: row.title, author: row.author, publisher: row.publisher, url: row.url, note: row.note }));

  const citations: PackageCitation[] = (db.prepare("SELECT * FROM family_tree_citations ORDER BY created_at, id").all() as FamilyTreeCitationRow[])
    .map((row) => ({
      id: row.id, sourceId: row.source_id, personId: row.person_id, eventId: row.event_id, unionId: row.union_id,
      fact: row.fact, detail: row.detail, url: row.url, note: row.note
    }));

  const { defaultPersonId } = getFamilyTreeSettings();
  const tree: PackageTree = {
    persons, unions, events, sources, citations,
    photos: [...photos.values()],
    settings: { defaultPersonId: defaultPersonId && persons.some((p) => p.id === defaultPersonId) ? defaultPersonId : null }
  };
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    appVersion: config.version,
    exportedAt: new Date().toISOString(),
    sourceServer: getServerId(),
    counts: {
      persons: persons.length,
      unions: unions.length,
      events: events.length,
      sources: sources.length,
      citations: citations.length,
      photos: photos.size,
      portraits: persons.filter((p) => p.portrait).length
    }
  };
  return { manifest, tree, media, warnings };
}

/** Write the package as a zip into `output` (a response, or a file for tests).
 *  Resolves when the archive has been fully handed to the stream. */
export async function writePackage(build: PackageBuild, output: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Photos are already compressed; level 1 keeps the CPU out of the way.
    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on("error", reject);
    archive.on("warning", (err: Error) => reject(err));
    output.on("error", reject);
    output.on("close", () => resolve());
    output.on("finish", () => resolve());
    archive.pipe(output);
    archive.append(JSON.stringify(build.manifest, null, 2), { name: MANIFEST_ENTRY });
    archive.append(JSON.stringify(build.tree), { name: TREE_ENTRY });
    archive.append(exportGedcom(), { name: GEDCOM_ENTRY });
    for (const file of build.media) archive.file(file.absolutePath, { name: file.entry });
    void archive.finalize();
  });
}

async function sha256Of(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(absolutePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}
