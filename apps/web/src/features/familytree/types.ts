// Client shapes for the family-tree API (see modules/familytree on the server).
import type { GalleryAsset } from "../gallery/types";

export interface FamilyPerson {
  id: string;
  name: string;
  maidenName: string | null;
  gender: "male" | "female" | "other" | "unknown";
  // Partial ISO dates: "YYYY" | "YYYY-MM" | "YYYY-MM-DD".
  birthDate: string | null;
  deathDate: string | null;
  birthplace: string | null;
  deathPlace: string | null;
  bio: string | null;
  portraitUrl: string | null;
  portraitItemId: string | null;
  galleryPersonId: string | null;
  // Family tags (branch names) on this person; also the edit-permission scope.
  tags: string[];
  // Whether the current user may edit this person (admin, or a tag grant).
  canEdit: boolean;
}

// What the current user may do with the tree overall. `canAdd` is true for
// admins and for anyone holding edit rights on at least one family tag.
export interface FamilyTreeAccess {
  isAdmin: boolean;
  canAdd: boolean;
}

export interface FamilyTag {
  id: string;
  name: string;
  count: number;
  editorCount: number;
}

export interface FamilyUnion {
  id: string;
  person1Id: string;
  person2Id: string | null;
  status: "married" | "partners" | "divorced" | "widowed" | "unknown";
  marriedDate: string | null;
  marriedPlace: string | null;
  divorcedDate: string | null;
  note: string | null;
}

export interface FamilyEvent {
  id: string;
  personId: string;
  type:
    | "residence" | "education" | "graduation" | "occupation" | "retirement" | "military"
    | "immigration" | "emigration" | "naturalization" | "travel" | "award" | "baptism"
    | "burial" | "custom";
  label: string | null;
  date: string | null;
  endDate: string | null;
  place: string | null;
  note: string | null;
  // Attached gallery photos, viewer-scoped; present on the profile payload.
  photos: GalleryAsset[];
}

export interface FamilyChildLink {
  unionId: string;
  childId: string;
  relation: "biological" | "adopted" | "step" | "foster" | "unknown";
}

export interface FamilyTree {
  persons: FamilyPerson[];
  unions: FamilyUnion[];
  children: FamilyChildLink[];
  access: FamilyTreeAccess;
  /**
   * Who the chart opens on when no person is named in the URL — set by an admin
   * in Family tree settings, and null when unset or the person has been deleted.
   */
  defaultPersonId: string | null;
}

export interface FamilyUnionDetail {
  id: string;
  status: FamilyUnion["status"];
  marriedDate: string | null;
  marriedPlace: string | null;
  divorcedDate: string | null;
  note: string | null;
  partner: FamilyPerson | null;
  children: (FamilyPerson & { relation: FamilyChildLink["relation"] })[];
}

export interface FamilySource {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  url: string | null;
  note: string | null;
  citationCount: number;
}

export interface FamilyCitation {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string | null;
  personId: string | null;
  eventId: string | null;
  unionId: string | null;
  fact: "name" | "birth" | "death" | "marriage" | "divorce" | null;
  detail: string | null;
  url: string | null;
  note: string | null;
}

export interface FamilyPersonProfile extends FamilyPerson {
  parents: FamilyPerson[];
  parentRelation: FamilyChildLink["relation"] | null;
  unions: FamilyUnionDetail[];
  events: FamilyEvent[];
  citations: FamilyCitation[];
  galleryPerson: { id: string; name: string } | null;
}

// A profile photo: a gallery asset plus whether it was explicitly attached
// (curated, removable here) or surfaced via the linked face cluster.
export type FamilyPhoto = GalleryAsset & { attached: boolean };

// UI offers a simple binary; the schema still tolerates other/unknown for
// quick-created people and any legacy/imported rows.
export const GENDER_OPTIONS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" }
] as const;

export const UNION_STATUS_OPTIONS = [
  { value: "married", label: "Married" },
  { value: "partners", label: "Partners" },
  { value: "divorced", label: "Divorced" },
  { value: "widowed", label: "Widowed" },
  { value: "unknown", label: "Unknown" }
] as const;

// Timeline event types. `custom` needs a label; for the rest the label is an
// optional short "what" (occupation title, school name). Alphabetical by
// label, with the "Other event" catch-all last.
export const EVENT_TYPE_OPTIONS = [
  { value: "award", label: "Award" },
  { value: "baptism", label: "Baptism" },
  { value: "burial", label: "Burial" },
  { value: "education", label: "Education" },
  { value: "emigration", label: "Emigration" },
  { value: "graduation", label: "Graduation" },
  { value: "immigration", label: "Immigration" },
  { value: "military", label: "Military service" },
  { value: "naturalization", label: "Naturalization" },
  { value: "residence", label: "Residence" },
  { value: "retirement", label: "Retirement" },
  { value: "travel", label: "Travel" },
  { value: "occupation", label: "Work" },
  { value: "custom", label: "Other event" }
] as const;

export const CHILD_RELATION_OPTIONS = [
  { value: "biological", label: "Biological" },
  { value: "adopted", label: "Adopted" },
  { value: "step", label: "Step" },
  { value: "foster", label: "Foster" },
  { value: "unknown", label: "Unknown" }
] as const;

// "1943–2010", "1943–", "–2010", or "" — years only, from partial dates.
export function lifeYears(person: Pick<FamilyPerson, "birthDate" | "deathDate">): string {
  const birth = person.birthDate?.slice(0, 4) ?? "";
  const death = person.deathDate?.slice(0, 4) ?? "";
  if (!birth && !death) return "";
  return `${birth}–${death}`;
}
