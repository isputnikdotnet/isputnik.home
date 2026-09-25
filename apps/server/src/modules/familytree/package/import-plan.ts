// Planning a package import (docs/family-tree-exchange-plan.md). Pure: reads the
// tree that is here, reads the package, honours the admin's per-person decisions,
// and returns exactly what would be written — the dry run IS this plan, and
// import-apply.ts writes it without deciding anything more.
//
// Two modes. **Replace** empties the tree first, so everything in the package is
// created. **Migrate** only ever adds: a record with no match is created, a blank
// field on a matched record is filled in, and a field that is set here stays as
// it is (listed as a difference) — unless the admin chose "use the package's
// values" for that person. Nothing is deleted in Migrate, ever.
//
// Per person, the admin decides: add (as a new person, also the way to undo a
// wrong match), skip, merge (fill blanks — the default for a match), usePackage
// (the package's values win, portrait included), or keepMine (match them so
// relationships connect, change nothing about them). A match can also be set by
// hand (`matchId`), for the person the matcher did not find.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { FAMILY_PERSON_ENTITY_TYPE } from "../access.js";
import { entityTagsByIds } from "../../library/shared/tagging.js";
import { thumbnailAbsolutePath } from "../../library/shared/thumbnail.js";
import { validateLibrarySource } from "../../library/shared/library-source.js";
import { getHouseLibrary } from "../../library/gallery/house-library.js";
import { getFamilyTreeSettings } from "../settings.js";
import { normaliseName, type PackageCitation, type PackageEvent, type PackagePerson, type PackagePhoto, type PackageTree, type PackageUnion } from "./format.js";
import type {
  FamilyTreeChildRow, FamilyTreeCitationRow, FamilyTreeEventPhotoRow, FamilyTreeEventRow, FamilyTreeOriginRow,
  FamilyTreePersonNameRow, FamilyTreePersonRow, FamilyTreePhotoRow, FamilyTreeSourceRow, FamilyTreeUnionRow, GalleryDetailRow
} from "../../../db/rows.js";

// ── Decisions ──

export type ImportMode = "migrate" | "replace";
export type PersonAction = "add" | "skip" | "merge" | "usePackage" | "keepMine";
export interface PersonDecision {
  action: PersonAction;
  /** For merge / usePackage / keepMine: the person here, when chosen by hand
   *  (or the matcher's own suggestion, echoed back). */
  matchId?: string | null;
}
export interface ImportDecisions {
  mode: ImportMode;
  persons: Record<string, PersonDecision>;
}

// ── Preview (what the admin sees) ──

export type MatchReason = "origin" | "nameAndBirth" | "name" | "manual";
export interface PersonMatch {
  localId: string;
  name: string;
  birthDate: string | null;
  deathDate: string | null;
  reason: MatchReason;
}
export type DifferenceField =
  | "name" | "maidenName" | "gender" | "birthDate" | "deathDate" | "deceased" | "birthplace" | "deathPlace"
  | "birthPin" | "deathPin" | "bio" | "portrait" | "parents";
export interface Difference {
  field: DifferenceField;
  here: string | null;
  package: string | null;
  /** What the plan does about it: keep what is here, or take the package's. */
  resolution: "keepHere" | "usePackage";
}

export interface PersonPreview {
  id: string;
  name: string;
  birthDate: string | null;
  deathDate: string | null;
  hasPortrait: boolean;
  photos: number;
  /** What the matcher found on its own, before any decision. */
  suggested: PersonMatch | null;
  /** The match the plan uses (a manual one, or the suggestion), if any. */
  match: PersonMatch | null;
  decision: PersonDecision;
  differences: Difference[];
  /** Fields blank here that the package fills in. */
  fills: DifferenceField[];
}

export interface ImportSummary {
  personsCreated: number;
  personsMatched: number;
  personsFilled: number;
  personsOverwritten: number;
  personsSkipped: number;
  personsRemoved: number;
  unionsCreated: number;
  childrenLinked: number;
  eventsCreated: number;
  sourcesCreated: number;
  citationsCreated: number;
  portraitsSet: number;
  photosImported: number;
  photosReused: number;
  differences: number;
}

export type NotCarried = "galleryLinks" | "branchEditors" | "photosNoStorage";

export interface ImportPreview {
  mode: ImportMode;
  persons: PersonPreview[];
  summary: ImportSummary;
  notCarried: NotCarried[];
  warnings: string[];
}

// ── Plan (what import-apply.ts writes) ──

export interface PersonFieldValues {
  name?: string;
  maiden_name?: string | null;
  gender?: string;
  birth_date?: string | null;
  death_date?: string | null;
  deceased?: number;
  birthplace?: string | null;
  death_place?: string | null;
  birth_lat?: number | null;
  birth_lng?: number | null;
  death_lat?: number | null;
  death_lng?: number | null;
  bio?: string | null;
}

export type PersonOp =
  | { kind: "create"; pkg: PackagePerson }
  | { kind: "update"; pkg: PackagePerson; localId: string; fields: PersonFieldValues; otherNames: { language: string; name: string }[]; tags: string[]; setPortrait: boolean }
  | { kind: "link"; pkg: PackagePerson; localId: string };

export type UnionOp =
  | { kind: "create"; pkg: PackageUnion }
  | { kind: "fillPartner"; pkg: PackageUnion; localId: string; partnerPkgId: string }
  | { kind: "link"; pkg: PackageUnion; localId: string };

export interface ChildOp { unionPkgId: string; childPkgId: string; relation: string }

export type EventOp =
  | { kind: "create"; pkg: PackageEvent }
  | { kind: "link"; pkg: PackageEvent; localId: string };

export type SourceOp =
  | { kind: "create"; pkg: { id: string; title: string; author?: string | null; publisher?: string | null; url?: string | null; note?: string | null } }
  | { kind: "link"; pkgId: string; localId: string };

export interface PhotoOp {
  pkg: PackagePhoto;
  /** Reuse this gallery item instead of importing the file. */
  localId: string | null;
  attachPersons: string[];
  attachEvents: string[];
}

export interface PortraitOp {
  personPkgId: string;
  file: string;
  crop: { x: number; y: number; w: number; h: number } | null;
  sourcePhotoId: string | null;
}

export interface ImportPlan {
  mode: ImportMode;
  sourceServer: string;
  persons: PersonOp[];
  unions: UnionOp[];
  children: ChildOp[];
  events: EventOp[];
  sources: SourceOp[];
  citations: PackageCitation[];
  photos: PhotoOp[];
  portraits: PortraitOp[];
  /** The package's start person (a package id), when the setting is to change. */
  defaultPersonPkgId: string | null;
  preview: ImportPreview;
}

// ── The tree that is here ──

interface LocalPerson {
  row: FamilyTreePersonRow;
  otherNames: { language: string; name: string }[];
  tags: string[];
  photos: Set<string>;
}

interface LocalTree {
  persons: Map<string, LocalPerson>;
  byName: Map<string, string[]>;
  unions: Pick<FamilyTreeUnionRow, "id" | "person1_id" | "person2_id">[];
  parentsOf: Map<string, string>;
  events: Pick<FamilyTreeEventRow, "id" | "person_id" | "type" | "label" | "date" | "end_date" | "place">[];
  eventPhotos: Map<string, Set<string>>;
  sourcesByTitle: Map<string, string>;
  citations: Set<string>;
  origins: Map<string, string>;
  photoByHash: Map<string, string>;
  hasHouseLibrary: boolean;
  defaultPersonId: string | null;
}

const EMPTY_TREE: LocalTree = {
  persons: new Map(), byName: new Map(), unions: [], parentsOf: new Map(), events: [], eventPhotos: new Map(),
  sourcesByTitle: new Map(), citations: new Set(), origins: new Map(), photoByHash: new Map(),
  hasHouseLibrary: false, defaultPersonId: null
};

const citationKey = (c: { sourceId: string; personId: string | null; eventId: string | null; unionId: string | null; fact: string | null; detail: string | null; url: string | null }) =>
  [c.sourceId, c.personId ?? "", c.eventId ?? "", c.unionId ?? "", c.fact ?? "", c.detail ?? "", c.url ?? ""].join("\u0000");

function loadLocalTree(pkg: PackageTree, sourceServer: string): LocalTree {
  const rows = db.prepare("SELECT * FROM family_tree_persons").all() as FamilyTreePersonRow[];
  const names = db.prepare("SELECT person_id, language, name FROM family_tree_person_names ORDER BY position")
    .all() as Pick<FamilyTreePersonNameRow, "person_id" | "language" | "name">[];
  const tags = entityTagsByIds(FAMILY_PERSON_ENTITY_TYPE, rows.map((r) => r.id));
  const photos = db.prepare("SELECT person_id, item_id FROM family_tree_photos").all() as Pick<FamilyTreePhotoRow, "person_id" | "item_id">[];
  const persons = new Map<string, LocalPerson>();
  const byName = new Map<string, string[]>();
  for (const row of rows) {
    persons.set(row.id, { row, otherNames: [], tags: tags.get(row.id) ?? [], photos: new Set() });
    const key = normaliseName(row.name);
    byName.set(key, [...(byName.get(key) ?? []), row.id]);
  }
  for (const n of names) persons.get(n.person_id)?.otherNames.push({ language: n.language, name: n.name });
  for (const p of photos) persons.get(p.person_id)?.photos.add(p.item_id);

  const parentsOf = new Map<string, string>();
  for (const c of db.prepare("SELECT union_id, child_id FROM family_tree_children").all() as Pick<FamilyTreeChildRow, "union_id" | "child_id">[]) {
    parentsOf.set(c.child_id, c.union_id);
  }
  const eventPhotos = new Map<string, Set<string>>();
  for (const ep of db.prepare("SELECT event_id, item_id FROM family_tree_event_photos").all() as Pick<FamilyTreeEventPhotoRow, "event_id" | "item_id">[]) {
    const set = eventPhotos.get(ep.event_id) ?? new Set<string>();
    set.add(ep.item_id);
    eventPhotos.set(ep.event_id, set);
  }
  const sourcesByTitle = new Map<string, string>();
  for (const s of db.prepare("SELECT id, title FROM family_tree_sources").all() as Pick<FamilyTreeSourceRow, "id" | "title">[]) {
    sourcesByTitle.set(s.title.trim().toLowerCase(), s.id);
  }
  const citations = new Set<string>();
  for (const c of db.prepare("SELECT source_id, person_id, event_id, union_id, fact, detail, url FROM family_tree_citations").all() as FamilyTreeCitationRow[]) {
    citations.add(citationKey({ sourceId: c.source_id, personId: c.person_id, eventId: c.event_id, unionId: c.union_id, fact: c.fact, detail: c.detail, url: c.url }));
  }

  // Origins whose record still exists. Photos count when the item is not binned.
  const origins = new Map<string, string>();
  const originRows = db.prepare(`
    SELECT o.entity_type, o.local_id, o.source_id FROM family_tree_origins o
    WHERE o.source_server = ? AND (
      (o.entity_type = 'person' AND EXISTS (SELECT 1 FROM family_tree_persons WHERE id = o.local_id)) OR
      (o.entity_type = 'union' AND EXISTS (SELECT 1 FROM family_tree_unions WHERE id = o.local_id)) OR
      (o.entity_type = 'event' AND EXISTS (SELECT 1 FROM family_tree_events WHERE id = o.local_id)) OR
      (o.entity_type = 'source' AND EXISTS (SELECT 1 FROM family_tree_sources WHERE id = o.local_id)) OR
      (o.entity_type = 'photo' AND EXISTS (SELECT 1 FROM library_items WHERE id = o.local_id AND deleted_at IS NULL))
    )
  `).all(sourceServer) as Pick<FamilyTreeOriginRow, "entity_type" | "local_id" | "source_id">[];
  for (const o of originRows) origins.set(`${o.entity_type}:${o.source_id}`, o.local_id);

  const photoByHash = new Map<string, string>();
  const hashes = (pkg.photos ?? []).map((p) => p.sha256).filter((h): h is string => Boolean(h));
  for (let i = 0; i < hashes.length; i += 500) {
    const slice = hashes.slice(i, i + 500);
    const found = db.prepare(`
      SELECT gd.content_hash, gd.item_id FROM gallery_details gd
      JOIN library_items li ON li.id = gd.item_id AND li.deleted_at IS NULL
      WHERE gd.content_hash IN (${slice.map(() => "?").join(", ")})
    `).all(...slice) as Pick<GalleryDetailRow, "content_hash" | "item_id">[];
    for (const f of found) if (f.content_hash && !photoByHash.has(f.content_hash)) photoByHash.set(f.content_hash, f.item_id);
  }

  return {
    persons, byName, parentsOf, eventPhotos, sourcesByTitle, citations, origins, photoByHash,
    unions: db.prepare("SELECT id, person1_id, person2_id FROM family_tree_unions").all() as LocalTree["unions"],
    events: db.prepare("SELECT id, person_id, type, label, date, end_date, place FROM family_tree_events").all() as LocalTree["events"],
    hasHouseLibrary: getHouseLibrary() != null,
    defaultPersonId: getFamilyTreeSettings().defaultPersonId
  };
}

// ── Matching people ──

const blank = (v: string | null | undefined) => v == null || v.trim() === "";

/** sha256 of a gallery item's original file here, read on demand and remembered
 *  for the rest of the plan; null when the item or its file is not there. Used to
 *  recognise a package photo among the photos already on a matched person's or
 *  event's wall, since `content_hash` is only filled by the duplicate scan. */
function localPhotoHasher(): (itemId: string) => string | null {
  const cache = new Map<string, string | null>();
  const lookup = db.prepare(`
    SELECT libraries.source_path, gd.relative_path FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    JOIN libraries ON libraries.id = li.library_id
    WHERE li.id = ? AND li.deleted_at IS NULL
  `);
  return (itemId) => {
    if (cache.has(itemId)) return cache.get(itemId)!;
    let hash: string | null = null;
    const row = lookup.get(itemId) as { source_path: string; relative_path: string } | undefined;
    if (row) {
      try {
        const root = validateLibrarySource(row.source_path);
        hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, ...row.relative_path.split("/")))).digest("hex");
      } catch {
        hash = null;
      }
    }
    cache.set(itemId, hash);
    return hash;
  };
}

/** The hash of a person's portrait file here, or null when they have none (or
 *  its file is missing, which reads as none: the package's can fill it). */
function portraitHash(row: FamilyTreePersonRow): string | null {
  if (!row.portrait_storage_key) return null;
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(thumbnailAbsolutePath(row.portrait_storage_key))).digest("hex");
  } catch {
    return null;
  }
}

function suggestMatches(pkg: PackageTree, local: LocalTree): Map<string, PersonMatch> {
  const taken = new Set<string>();
  const out = new Map<string, PersonMatch>();
  const matchOf = (id: string, reason: MatchReason): PersonMatch => {
    const row = local.persons.get(id)!.row;
    return { localId: id, name: row.name, birthDate: row.birth_date, deathDate: row.death_date, reason };
  };
  // 1. Same origin — exact, so it goes first and takes precedence.
  for (const person of pkg.persons) {
    const id = local.origins.get(`person:${person.id}`);
    if (id && !taken.has(id)) { out.set(person.id, matchOf(id, "origin")); taken.add(id); }
  }
  const pkgByName = new Map<string, PackagePerson[]>();
  for (const person of pkg.persons) {
    const key = normaliseName(person.name);
    pkgByName.set(key, [...(pkgByName.get(key) ?? []), person]);
  }
  // 2. Same name and the same birth date.
  for (const person of pkg.persons) {
    if (out.has(person.id) || blank(person.birthDate)) continue;
    const candidates = (local.byName.get(normaliseName(person.name)) ?? [])
      .filter((id) => !taken.has(id) && local.persons.get(id)!.row.birth_date === person.birthDate);
    if (candidates.length === 1) { out.set(person.id, matchOf(candidates[0], "nameAndBirth")); taken.add(candidates[0]); }
  }
  // 3. Same name alone, when — among those still unmatched — it is unique on
  //    both sides and one side has no birth date. Two people of one name with
  //    different dates never match.
  for (const person of pkg.persons) {
    if (out.has(person.id)) continue;
    const key = normaliseName(person.name);
    if ((pkgByName.get(key) ?? []).filter((p) => !out.has(p.id)).length !== 1) continue;
    const candidates = (local.byName.get(key) ?? []).filter((id) => !taken.has(id));
    if (candidates.length !== 1) continue;
    const here = local.persons.get(candidates[0])!.row;
    if (blank(here.birth_date) || blank(person.birthDate)) {
      out.set(person.id, matchOf(candidates[0], "name"));
      taken.add(candidates[0]);
    }
  }
  return out;
}

// ── Field comparison ──

const pinText = (p: { lat: number; lng: number } | null | undefined) => (p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : null);

interface FieldSpec {
  field: DifferenceField;
  here: (p: FamilyTreePersonRow) => string | null;
  pkg: (p: PackagePerson) => string | null;
  /** Column values that make the local row carry the package's value. */
  set: (p: PackagePerson) => PersonFieldValues;
}

const FIELDS: FieldSpec[] = [
  { field: "name", here: (r) => r.name, pkg: (p) => p.name.trim() || null, set: (p) => ({ name: p.name.trim() }) },
  { field: "maidenName", here: (r) => r.maiden_name, pkg: (p) => p.maidenName?.trim() || null, set: (p) => ({ maiden_name: p.maidenName?.trim() || null }) },
  { field: "gender", here: (r) => (r.gender === "unknown" ? null : r.gender), pkg: (p) => (p.gender && p.gender !== "unknown" ? p.gender : null), set: (p) => ({ gender: p.gender ?? "unknown" }) },
  { field: "birthDate", here: (r) => r.birth_date, pkg: (p) => p.birthDate || null, set: (p) => ({ birth_date: p.birthDate || null }) },
  { field: "deathDate", here: (r) => r.death_date, pkg: (p) => p.deathDate || null, set: (p) => ({ death_date: p.deathDate || null }) },
  { field: "deceased", here: (r) => (r.deceased ? "yes" : null), pkg: (p) => (p.deceased ? "yes" : null), set: (p) => ({ deceased: p.deceased ? 1 : 0 }) },
  { field: "birthplace", here: (r) => r.birthplace, pkg: (p) => p.birthplace?.trim() || null, set: (p) => ({ birthplace: p.birthplace?.trim() || null }) },
  { field: "deathPlace", here: (r) => r.death_place, pkg: (p) => p.deathPlace?.trim() || null, set: (p) => ({ death_place: p.deathPlace?.trim() || null }) },
  { field: "birthPin", here: (r) => pinText(r.birth_lat != null && r.birth_lng != null ? { lat: r.birth_lat, lng: r.birth_lng } : null), pkg: (p) => pinText(p.birthPin), set: (p) => ({ birth_lat: p.birthPin?.lat ?? null, birth_lng: p.birthPin?.lng ?? null }) },
  { field: "deathPin", here: (r) => pinText(r.death_lat != null && r.death_lng != null ? { lat: r.death_lat, lng: r.death_lng } : null), pkg: (p) => pinText(p.deathPin), set: (p) => ({ death_lat: p.deathPin?.lat ?? null, death_lng: p.deathPin?.lng ?? null }) },
  { field: "bio", here: (r) => r.bio, pkg: (p) => p.bio?.trim() || null, set: (p) => ({ bio: p.bio?.trim() || null }) }
];

// ── The plan ──

export function planImport(pkg: PackageTree, sourceServer: string, decisions: ImportDecisions): ImportPlan {
  const mode = decisions.mode;
  const live = loadLocalTree(pkg, sourceServer);
  // Replace plans against an empty tree: everything is created.
  const local: LocalTree = mode === "replace" ? { ...EMPTY_TREE, hasHouseLibrary: live.hasHouseLibrary } : live;
  const warnings: string[] = [];
  const suggestions = suggestMatches(pkg, local);

  const summary: ImportSummary = {
    personsCreated: 0, personsMatched: 0, personsFilled: 0, personsOverwritten: 0, personsSkipped: 0,
    personsRemoved: mode === "replace" ? live.persons.size : 0,
    unionsCreated: 0, childrenLinked: 0, eventsCreated: 0, sourcesCreated: 0, citationsCreated: 0,
    portraitsSet: 0, photosImported: 0, photosReused: 0, differences: 0
  };

  // Persons: decide, compare, and remember where each package person lands.
  // `localOf` is the person here for a matched one; created ones have no local
  // id until apply and are marked `created`.
  const personOps: PersonOp[] = [];
  const previews: PersonPreview[] = [];
  const localOf = new Map<string, string>();
  const created = new Set<string>();
  const skipped = new Set<string>();
  /** Persons whose events, photos and portrait are to be left alone (keepMine). */
  const frozen = new Set<string>();
  const usedLocal = new Set<string>();
  const portraits: PortraitOp[] = [];
  const photoAttach = new Map<string, { persons: string[]; events: string[] }>();
  const wantPhoto = (pkgPhotoId: string, target: { person?: string; event?: string }) => {
    const entry = photoAttach.get(pkgPhotoId) ?? { persons: [], events: [] };
    if (target.person) entry.persons.push(target.person);
    if (target.event) entry.events.push(target.event);
    photoAttach.set(pkgPhotoId, entry);
  };
  const pkgPhotos = new Map((pkg.photos ?? []).map((p) => [p.id, p]));
  const hashOf = localPhotoHasher();
  /** The photo here that is the package photo: by origin, by the duplicate
   *  scan's hash, or — among `candidates`, the wall it would join — by hashing
   *  those files now. */
  const samePhotoHere = (photo: PackagePhoto, candidates: Iterable<string>): string | null => {
    const known = local.origins.get(`photo:${photo.id}`) ?? (photo.sha256 ? local.photoByHash.get(photo.sha256) : undefined);
    if (known) return known;
    if (!photo.sha256) return null;
    for (const itemId of candidates) if (hashOf(itemId) === photo.sha256) return itemId;
    return null;
  };

  for (const person of pkg.persons) {
    const suggested = suggestions.get(person.id) ?? null;
    const given = decisions.persons[person.id];
    let decision: PersonDecision;
    let match: PersonMatch | null = null;
    if (mode === "replace") {
      decision = given?.action === "skip" ? { action: "skip" } : { action: "add" };
    } else if (given?.action === "skip" || given?.action === "add") {
      decision = { action: given.action };
    } else if (given && (given.action === "merge" || given.action === "usePackage" || given.action === "keepMine")) {
      const wanted = given.matchId ?? suggested?.localId ?? null;
      const target = wanted && local.persons.get(wanted) && !usedLocal.has(wanted) ? local.persons.get(wanted)! : null;
      if (target) {
        match = wanted === suggested?.localId
          ? suggested
          : { localId: target.row.id, name: target.row.name, birthDate: target.row.birth_date, deathDate: target.row.death_date, reason: "manual" };
        decision = { action: given.action, matchId: target.row.id };
      } else {
        // The chosen person is gone or already taken: created instead, and said so.
        decision = { action: "add" };
        if (wanted) warnings.push(`${person.name}: the person chosen to match them is no longer available — added as a new person.`);
      }
    } else if (suggested && !usedLocal.has(suggested.localId)) {
      match = suggested;
      decision = { action: "merge", matchId: suggested.localId };
    } else {
      decision = { action: "add" };
    }

    const preview: PersonPreview = {
      id: person.id, name: person.name, birthDate: person.birthDate ?? null, deathDate: person.deathDate ?? null,
      hasPortrait: Boolean(person.portrait), photos: person.photos?.length ?? 0,
      suggested, match, decision, differences: [], fills: []
    };
    previews.push(preview);

    if (decision.action === "skip") {
      skipped.add(person.id);
      summary.personsSkipped += 1;
      continue;
    }
    if (!match) {
      created.add(person.id);
      personOps.push({ kind: "create", pkg: person });
      summary.personsCreated += 1;
      if (person.portrait) {
        portraits.push({ personPkgId: person.id, file: person.portrait.file, crop: person.portrait.crop ?? null, sourcePhotoId: person.portrait.sourcePhotoId ?? null });
        if (person.portrait.sourcePhotoId && pkgPhotos.has(person.portrait.sourcePhotoId)) wantPhoto(person.portrait.sourcePhotoId, {});
      }
      for (const photoId of person.photos ?? []) if (pkgPhotos.has(photoId)) wantPhoto(photoId, { person: person.id });
      continue;
    }

    usedLocal.add(match.localId);
    localOf.set(person.id, match.localId);
    summary.personsMatched += 1;
    const here = local.persons.get(match.localId)!;
    if (decision.action === "keepMine") {
      frozen.add(person.id);
      personOps.push({ kind: "link", pkg: person, localId: match.localId });
      continue;
    }

    const overwrite = decision.action === "usePackage";
    const fields: PersonFieldValues = {};
    for (const spec of FIELDS) {
      // Whitespace at the ends is not a difference; a value of only spaces is blank.
      const a = spec.here(here.row)?.trim() || null;
      const b = spec.pkg(person)?.trim() || null;
      if (b == null) continue;
      if (a == null) { Object.assign(fields, spec.set(person)); preview.fills.push(spec.field); continue; }
      if (a === b) continue;
      preview.differences.push({ field: spec.field, here: a, package: b, resolution: overwrite ? "usePackage" : "keepHere" });
      if (overwrite) Object.assign(fields, spec.set(person));
    }
    let setPortrait = false;
    if (person.portrait) {
      const hereHash = portraitHash(here.row);
      if (!hereHash && !here.row.portrait_item_id) { setPortrait = true; preview.fills.push("portrait"); }
      else if (hereHash && person.portrait.sha256 && hereHash === person.portrait.sha256) {
        // The same picture already: nothing to do, nothing to report.
      } else {
        preview.differences.push({ field: "portrait", here: "yes", package: "yes", resolution: overwrite ? "usePackage" : "keepHere" });
        setPortrait = overwrite;
      }
    }
    if (setPortrait) {
      portraits.push({ personPkgId: person.id, file: person.portrait!.file, crop: person.portrait!.crop ?? null, sourcePhotoId: person.portrait!.sourcePhotoId ?? null });
      if (person.portrait!.sourcePhotoId && pkgPhotos.has(person.portrait!.sourcePhotoId)) wantPhoto(person.portrait!.sourcePhotoId, {});
    }
    const haveNames = new Set(here.otherNames.map((n) => `${n.language}\u0000${n.name}`));
    const otherNames = (person.otherNames ?? []).filter((n) => !haveNames.has(`${n.language}\u0000${n.name}`));
    const haveTags = new Set(here.tags.map((t) => t.toLowerCase()));
    const tagsToAdd = (person.tags ?? []).filter((t) => !haveTags.has(t.toLowerCase()));
    for (const photoId of person.photos ?? []) {
      const photo = pkgPhotos.get(photoId);
      if (!photo) continue;
      // Already on the profile here (same origin or same file)? Then nothing to attach.
      const existing = samePhotoHere(photo, here.photos);
      if (existing && here.photos.has(existing)) continue;
      wantPhoto(photoId, { person: person.id });
    }
    const changes = Object.keys(fields).length > 0 || otherNames.length > 0 || tagsToAdd.length > 0 || setPortrait;
    if (overwrite && preview.differences.length > 0) summary.personsOverwritten += 1;
    else if (preview.fills.length > 0 || otherNames.length > 0) summary.personsFilled += 1;
    personOps.push(changes
      ? { kind: "update", pkg: person, localId: match.localId, fields, otherNames, tags: tagsToAdd, setPortrait }
      : { kind: "link", pkg: person, localId: match.localId });
  }

  /** The person here for a package id, or "created" for one this import makes,
   *  or null when skipped / unknown. */
  const resolve = (pkgId: string | null | undefined): string | "created" | null => {
    if (!pkgId) return null;
    if (created.has(pkgId)) return "created";
    return localOf.get(pkgId) ?? null;
  };
  const pkgPersonName = new Map(pkg.persons.map((p) => [p.id, p.name]));

  // Unions.
  const unionOps: UnionOp[] = [];
  const childOps: ChildOp[] = [];
  const unionLocalOf = new Map<string, string>();
  const unionCreated = new Set<string>();
  const parentsOf = new Map(local.parentsOf);
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const unionByPair = new Map<string, string>();
  const singleUnionsOf = new Map<string, string[]>();
  for (const u of local.unions) {
    if (u.person2_id) unionByPair.set(pairKey(u.person1_id, u.person2_id), u.id);
    else singleUnionsOf.set(u.person1_id, [...(singleUnionsOf.get(u.person1_id) ?? []), u.id]);
  }
  for (const union of pkg.unions ?? []) {
    const p1 = resolve(union.person1Id);
    const p2 = union.person2Id ? resolve(union.person2Id) : null;
    if (!p1 || (union.person2Id && !p2)) {
      if ((union.children?.length ?? 0) > 0 || union.marriedDate || union.status !== "unknown") {
        warnings.push(`The family of ${pkgPersonName.get(union.person1Id) ?? "?"}${union.person2Id ? ` and ${pkgPersonName.get(union.person2Id) ?? "?"}` : ""} was left out: a partner was skipped.`);
      }
      continue;
    }
    let op: UnionOp | null = null;
    // The same family here: by origin, or the same two partners in either order.
    const existing = local.origins.get(`union:${union.id}`)
      ?? (p1 !== "created" && p2 && p2 !== "created" ? unionByPair.get(pairKey(p1, p2)) : undefined);
    if (existing && !existing.startsWith("pkg:")) op = { kind: "link", pkg: union, localId: existing };
    // A single-parent family in the package is the same as a single-parent
    // family of that person here.
    if (!op && !existing && !p2 && p1 !== "created") {
      const single = (singleUnionsOf.get(p1) ?? [])[0];
      if (single) {
        op = { kind: "link", pkg: union, localId: single };
        singleUnionsOf.set(p1, (singleUnionsOf.get(p1) ?? []).filter((id) => id !== single));
      }
    }
    // A single-parent family here whose empty slot the package's partner fills.
    if (!op && !existing && p2) {
      for (const [self, other, otherPkgId] of [[p1, p2, union.person2Id!], [p2, p1, union.person1Id]] as const) {
        if (self === "created") continue;
        const single = (singleUnionsOf.get(self) ?? [])[0];
        if (!single) continue;
        op = { kind: "fillPartner", pkg: union, localId: single, partnerPkgId: otherPkgId };
        singleUnionsOf.set(self, (singleUnionsOf.get(self) ?? []).filter((id) => id !== single));
        if (other !== "created") unionByPair.set(pairKey(self, other), single);
        break;
      }
    }
    if (!op) {
      op = { kind: "create", pkg: union };
      unionCreated.add(union.id);
      summary.unionsCreated += 1;
      if (p1 !== "created" && p2 && p2 !== "created") unionByPair.set(pairKey(p1, p2), `pkg:${union.id}`);
    } else {
      unionLocalOf.set(union.id, op.localId);
    }
    unionOps.push(op);

    for (const child of union.children ?? []) {
      const c = resolve(child.personId);
      if (!c) continue;
      if (c !== "created") {
        const have = parentsOf.get(c);
        if (have) {
          if (op.kind !== "create" && have === op.localId) continue;
          const preview = previews.find((p) => p.id === child.personId);
          preview?.differences.push({ field: "parents", here: "yes", package: "yes", resolution: "keepHere" });
          continue;
        }
        parentsOf.set(c, op.kind === "create" ? `pkg:${union.id}` : op.localId);
      }
      childOps.push({ unionPkgId: union.id, childPkgId: child.personId, relation: child.relation ?? "biological" });
      summary.childrenLinked += 1;
    }
  }

  // Events: a person's events come along unless the person is skipped or frozen.
  const eventOps: EventOp[] = [];
  const eventLocalOf = new Map<string, string>();
  const eventCreated = new Set<string>();
  const usedEvents = new Set<string>();
  for (const event of pkg.events ?? []) {
    const p = resolve(event.personId);
    if (!p || frozen.has(event.personId)) continue;
    let localId: string | null = null;
    if (p !== "created") {
      localId = local.origins.get(`event:${event.id}`) ?? null;
      if (!localId) {
        const same = local.events.find((e) => !usedEvents.has(e.id) && e.person_id === p && e.type === event.type
          && (e.date ?? null) === (event.date ?? null)
          && (blank(e.label) || blank(event.label) || e.label!.trim().toLowerCase() === event.label!.trim().toLowerCase())
          && (blank(e.place) || blank(event.place) || e.place!.trim().toLowerCase() === event.place!.trim().toLowerCase()));
        localId = same?.id ?? null;
      }
    }
    if (localId) {
      usedEvents.add(localId);
      eventLocalOf.set(event.id, localId);
      eventOps.push({ kind: "link", pkg: event, localId });
      const have = local.eventPhotos.get(localId) ?? new Set<string>();
      for (const photoId of event.photos ?? []) {
        const photo = pkgPhotos.get(photoId);
        if (!photo) continue;
        const existing = samePhotoHere(photo, have);
        if (existing && have.has(existing)) continue;
        wantPhoto(photoId, { event: event.id });
      }
    } else {
      eventCreated.add(event.id);
      eventOps.push({ kind: "create", pkg: event });
      summary.eventsCreated += 1;
      for (const photoId of event.photos ?? []) if (pkgPhotos.has(photoId)) wantPhoto(photoId, { event: event.id });
    }
  }

  // Sources by title; citations only ever added, never twice.
  const sourceOps: SourceOp[] = [];
  const sourceLocalOf = new Map<string, string>();
  const sourceCreated = new Set<string>();
  const sourceTitles = new Map(local.sourcesByTitle);
  for (const source of pkg.sources ?? []) {
    const key = source.title.trim().toLowerCase();
    const existing = local.origins.get(`source:${source.id}`) ?? sourceTitles.get(key);
    if (existing) {
      if (existing.startsWith("pkg:")) { sourceLocalOf.set(source.id, existing); continue; }
      sourceLocalOf.set(source.id, existing);
      sourceOps.push({ kind: "link", pkgId: source.id, localId: existing });
    } else {
      sourceCreated.add(source.id);
      sourceTitles.set(key, `pkg:${source.id}`);
      sourceOps.push({ kind: "create", pkg: source });
      summary.sourcesCreated += 1;
    }
  }
  const citations: PackageCitation[] = [];
  const seenCitations = new Set(local.citations);
  for (const citation of pkg.citations ?? []) {
    const sourceRef = sourceLocalOf.get(citation.sourceId) ?? (sourceCreated.has(citation.sourceId) ? `pkg:${citation.sourceId}` : null);
    if (!sourceRef) continue;
    let personRef: string | null = null;
    let eventRef: string | null = null;
    let unionRef: string | null = null;
    if (citation.personId) {
      const p = resolve(citation.personId);
      if (!p || frozen.has(citation.personId)) continue;
      personRef = p === "created" ? `pkg:${citation.personId}` : p;
    } else if (citation.eventId) {
      const e = eventLocalOf.get(citation.eventId) ?? (eventCreated.has(citation.eventId) ? `pkg:${citation.eventId}` : null);
      if (!e) continue;
      eventRef = e;
    } else if (citation.unionId) {
      const u = unionLocalOf.get(citation.unionId) ?? (unionCreated.has(citation.unionId) ? `pkg:${citation.unionId}` : null);
      if (!u) continue;
      unionRef = u;
    } else continue;
    const key = citationKey({ sourceId: sourceRef, personId: personRef, eventId: eventRef, unionId: unionRef, fact: citation.fact ?? null, detail: citation.detail ?? null, url: citation.url ?? null });
    if (seenCitations.has(key)) continue;
    seenCitations.add(key);
    citations.push(citation);
    summary.citationsCreated += 1;
  }

  // Photos: reused when the same file is here already, else imported into App
  // files — which needs App storage to be on.
  const photoOps: PhotoOp[] = [];
  const notCarried: NotCarried[] = ["galleryLinks", "branchEditors"];
  let photosWithoutStorage = 0;
  for (const [photoId, attach] of photoAttach) {
    const photo = pkgPhotos.get(photoId)!;
    // The walls this photo would join: if the same file is on one of them
    // already (under another item), that item is reused.
    const candidates = new Set<string>();
    for (const pkgPersonId of attach.persons) {
      const localId = localOf.get(pkgPersonId);
      if (localId) for (const id of local.persons.get(localId)?.photos ?? []) candidates.add(id);
    }
    for (const pkgEventId of attach.events) {
      const localId = eventLocalOf.get(pkgEventId);
      if (localId) for (const id of local.eventPhotos.get(localId) ?? []) candidates.add(id);
    }
    const localId = samePhotoHere(photo, candidates);
    if (localId) summary.photosReused += 1;
    else if (!local.hasHouseLibrary) { photosWithoutStorage += 1; continue; }
    else summary.photosImported += 1;
    photoOps.push({ pkg: photo, localId, attachPersons: attach.persons, attachEvents: attach.events });
  }
  if (photosWithoutStorage > 0) {
    notCarried.push("photosNoStorage");
    warnings.push(`${photosWithoutStorage} photo${photosWithoutStorage === 1 ? "" : "s"} could not be imported: App storage is off on this server (Control panel → Library → Storage).`);
  }
  summary.portraitsSet = portraits.length;
  summary.differences = previews.reduce((n, p) => n + p.differences.length, 0);

  // The start person: only when none is set here (or the person is gone).
  let defaultPersonPkgId: string | null = null;
  const pkgDefault = pkg.settings?.defaultPersonId ?? null;
  if (pkgDefault && resolve(pkgDefault)) {
    const hereDefault = local.defaultPersonId && live.persons.has(local.defaultPersonId) ? local.defaultPersonId : null;
    if (!hereDefault || mode === "replace") defaultPersonPkgId = pkgDefault;
    else if (hereDefault !== localOf.get(pkgDefault)) {
      warnings.push(`The tree here opens on ${live.persons.get(hereDefault)!.row.name}; the package's start person (${pkgPersonName.get(pkgDefault) ?? "?"}) was not applied.`);
    }
  }

  return {
    mode, sourceServer,
    persons: personOps, unions: unionOps, children: childOps, events: eventOps, sources: sourceOps, citations,
    photos: photoOps, portraits, defaultPersonPkgId,
    preview: { mode, persons: previews, summary, notCarried, warnings }
  };
}
