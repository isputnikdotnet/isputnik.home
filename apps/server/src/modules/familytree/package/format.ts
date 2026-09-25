// The family-tree PACKAGE: a zip that moves a whole tree between two copies of
// this app, with everything GEDCOM drops (docs/family-tree-exchange-plan.md):
// portraits and their crop, photos on people and events, place pins, names in
// other languages, branch tags, and the person the chart opens on.
//
//   manifest.json   what the zip is, who made it, how much is inside
//   tree.json       the PackageTree below
//   media/portraits/<personId>.jpg          the portrait as shown
//   media/photos/<itemId>.<ext>             originals of every photo referenced
//   family-tree.ged                         the GEDCOM export, for other programs
//
// Every record carries its id ON THE EXPORTING SERVER. Those ids are never used
// as row ids on import; they only let the importer match records, and let a
// later package from the same server find them again (family_tree_origins).
import { z } from "zod";

export const PACKAGE_FORMAT = "isputnik-family-tree";
/** Bumped on a breaking change to tree.json. A newer major is refused; a field
 *  missing from an older package reads as empty. */
export const PACKAGE_FORMAT_VERSION = 1;

export const MANIFEST_ENTRY = "manifest.json";
export const TREE_ENTRY = "tree.json";
export const GEDCOM_ENTRY = "family-tree.ged";
export const PORTRAITS_DIR = "media/portraits";
export const PHOTOS_DIR = "media/photos";

const pin = z.object({ lat: z.number(), lng: z.number() }).nullable().optional();
const text = z.string().nullable().optional();
const id = z.string().min(1).max(64);

export const packagePersonSchema = z.object({
  id,
  name: z.string().min(1),
  maidenName: text,
  otherNames: z.array(z.object({ language: z.string(), name: z.string() })).optional(),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  birthDate: text,
  deathDate: text,
  deceased: z.boolean().optional(),
  birthplace: text,
  deathPlace: text,
  birthPin: pin,
  deathPin: pin,
  bio: text,
  tags: z.array(z.string()).optional(),
  /** The portrait as shown, and the photo it was cut from (a package photo id)
   *  with the frame, when it came from one. */
  portrait: z.object({
    file: z.string(),
    /** Of the portrait file, so an import can tell "the same portrait" from a new one. */
    sha256: text,
    crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
    sourcePhotoId: text
  }).nullable().optional(),
  /** Package photo ids attached to the person's profile, in order. */
  photos: z.array(id).optional()
});

export const packageUnionSchema = z.object({
  id,
  person1Id: id,
  person2Id: id.nullable().optional(),
  status: z.enum(["married", "partners", "divorced", "widowed", "unknown"]).optional(),
  marriedDate: text,
  marriedPlace: text,
  marriedPin: pin,
  divorcedDate: text,
  note: text,
  children: z.array(z.object({
    personId: id,
    relation: z.enum(["biological", "adopted", "step", "foster", "unknown"]).optional()
  })).optional()
});

export const packageEventSchema = z.object({
  id,
  personId: id,
  type: z.string().min(1),
  label: text,
  date: text,
  endDate: text,
  place: text,
  placePin: pin,
  note: text,
  photos: z.array(id).optional()
});

export const packageSourceSchema = z.object({
  id,
  title: z.string().min(1),
  author: text,
  publisher: text,
  url: text,
  note: text
});

export const packageCitationSchema = z.object({
  id,
  sourceId: id,
  personId: id.nullable().optional(),
  eventId: id.nullable().optional(),
  unionId: id.nullable().optional(),
  fact: z.enum(["name", "birth", "death", "marriage", "divorce"]).nullable().optional(),
  detail: text,
  url: text,
  note: text
});

/** A gallery item the tree refers to (portrait source, person or event photo),
 *  with its original file in the zip. `sha256` lets the importer reuse the same
 *  photo when the receiving gallery already has it. */
export const packagePhotoSchema = z.object({
  id,
  file: z.string().min(1),
  fileName: z.string().min(1),
  kind: z.enum(["photo", "video"]).optional(),
  sha256: z.string().nullable().optional(),
  takenAt: text
});

export const packageTreeSchema = z.object({
  persons: z.array(packagePersonSchema),
  unions: z.array(packageUnionSchema).optional(),
  events: z.array(packageEventSchema).optional(),
  sources: z.array(packageSourceSchema).optional(),
  citations: z.array(packageCitationSchema).optional(),
  photos: z.array(packagePhotoSchema).optional(),
  settings: z.object({ defaultPersonId: id.nullable().optional() }).optional()
});

export const packageManifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().optional(),
  exportedAt: z.string(),
  /** A random id the exporting server keeps in app_settings — the "same origin"
   *  half of family_tree_origins. */
  sourceServer: z.string().min(1),
  counts: z.record(z.string(), z.number()).optional()
});

export type PackagePerson = z.infer<typeof packagePersonSchema>;
export type PackageUnion = z.infer<typeof packageUnionSchema>;
export type PackageEvent = z.infer<typeof packageEventSchema>;
export type PackageSource = z.infer<typeof packageSourceSchema>;
export type PackageCitation = z.infer<typeof packageCitationSchema>;
export type PackagePhoto = z.infer<typeof packagePhotoSchema>;
export type PackageTree = z.infer<typeof packageTreeSchema>;
export type PackageManifest = z.infer<typeof packageManifestSchema>;

/** Names case, spacing and punctuation apart — how two people are judged to be
 *  "the same name" when matching (docs/family-tree-exchange-plan.md). */
export function normaliseName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
