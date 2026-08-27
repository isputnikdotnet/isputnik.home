// Client shapes for the family-tree API (see modules/familytree on the server).
import i18n from "../../i18n";
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
  { value: "female" },
  { value: "male" }
] as const;

export const UNION_STATUS_OPTIONS = [
  { value: "married" },
  { value: "partners" },
  { value: "divorced" },
  { value: "widowed" },
  { value: "unknown" }
] as const;

// Timeline event types. `custom` needs a label; for the rest the label is an
// optional short "what" (occupation title, school name). Alphabetical by
// label, with the "Other event" catch-all last.
export const EVENT_TYPE_OPTIONS = [
  { value: "award" },
  { value: "baptism" },
  { value: "burial" },
  { value: "education" },
  { value: "emigration" },
  { value: "graduation" },
  { value: "immigration" },
  { value: "military" },
  { value: "naturalization" },
  { value: "residence" },
  { value: "retirement" },
  { value: "travel" },
  { value: "occupation" },
  { value: "custom" }
] as const;

export const CHILD_RELATION_OPTIONS = [
  { value: "biological" },
  { value: "adopted" },
  { value: "step" },
  { value: "foster" },
  { value: "unknown" }
] as const;

// Label lookups, called at render/call time (never cached at module scope) so
// they stay reactive to a language switch — same approach as control/nav.ts.
export function genderOptionLabel(value: "female" | "male"): string {
  return i18n.t(`family:options.gender.${value}`);
}

export function genderLabel(gender: FamilyPerson["gender"]): string {
  return i18n.t(`family:options.gender.${gender}`);
}

export function unionStatusLabel(status: FamilyUnion["status"]): string {
  return i18n.t(`family:options.unionStatus.${status}`);
}

export function eventTypeLabel(type: FamilyEvent["type"]): string {
  return i18n.t(`family:options.eventType.${type}`);
}

export function eventLabelHint(type: FamilyEvent["type"]): string {
  return i18n.t(`family:eventLabelHints.${type}`);
}

export function childRelationLabel(relation: FamilyChildLink["relation"]): string {
  return i18n.t(`family:options.childRelation.${relation}`);
}

// The gendered noun for a child relative in text like "Birth of {{noun}} {{name}}"
// — "son"/"daughter"/"child", or "stepson"/"adopted daughter"/"foster child".
const CHILD_NOUN_BUCKET: Record<FamilyChildLink["relation"], "plain" | "step" | "adopted" | "foster"> = {
  biological: "plain",
  unknown: "plain",
  step: "step",
  adopted: "adopted",
  foster: "foster"
};

export function childRelativeNoun(relation: FamilyChildLink["relation"], gender: FamilyPerson["gender"]): string {
  const bucket = CHILD_NOUN_BUCKET[relation];
  const genderKey = gender === "male" || gender === "female" ? gender : "neutral";
  return i18n.t(`family:childNoun.${bucket}.${genderKey}`);
}

// "1943–2010", "1943–", "–2010", or "" — years only, from partial dates.
export function lifeYears(person: Pick<FamilyPerson, "birthDate" | "deathDate">): string {
  const birth = person.birthDate?.slice(0, 4) ?? "";
  const death = person.deathDate?.slice(0, 4) ?? "";
  if (!birth && !death) return "";
  return `${birth}–${death}`;
}
