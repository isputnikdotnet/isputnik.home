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
  bio: string | null;
  portraitUrl: string | null;
  portraitItemId: string | null;
  galleryPersonId: string | null;
}

export interface FamilyUnion {
  id: string;
  person1Id: string;
  person2Id: string | null;
  status: "married" | "partners" | "divorced" | "widowed" | "unknown";
  marriedDate: string | null;
  divorcedDate: string | null;
  note: string | null;
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
}

export interface FamilyUnionDetail {
  id: string;
  status: FamilyUnion["status"];
  marriedDate: string | null;
  divorcedDate: string | null;
  note: string | null;
  partner: FamilyPerson | null;
  children: (FamilyPerson & { relation: FamilyChildLink["relation"] })[];
}

export interface FamilyPersonProfile extends FamilyPerson {
  parents: FamilyPerson[];
  parentRelation: FamilyChildLink["relation"] | null;
  unions: FamilyUnionDetail[];
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
