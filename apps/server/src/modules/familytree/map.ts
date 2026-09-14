// Where the family's lives happened, for the family map: every place in the tree
// that carries a pin — births, deaths, marriages and life events — as one list of
// entries. A place only has a pin when it was picked from the places search, so
// `unpinned` counts the places still written as words alone, which the page
// turns into a hint rather than guessing coordinates from text.
//
// Entries name people by id only: the page already has every person (with their
// portrait) from the tree payload, and joins the two.
import { db } from "../../db.js";
import type { FamilyTreeEventRow, FamilyTreePersonRow, FamilyTreeUnionRow } from "../../db/rows.js";

export type FamilyMapEntryKind = "birth" | "death" | "marriage" | "event";

export interface FamilyMapEntry {
  /** Stable across loads: `${kind}:${row id}`. */
  id: string;
  kind: FamilyMapEntryKind;
  /** The person it happened to; both partners for a marriage. */
  personIds: string[];
  place: string;
  lat: number;
  lng: number;
  date: string | null;
  /** Life events only. */
  endDate: string | null;
  eventType: string | null;
  label: string | null;
}

export interface FamilyMapPayload {
  entries: FamilyMapEntry[];
  /** Places written without a pin, which the map cannot show. */
  unpinned: number;
}

export function getFamilyMap(): FamilyMapPayload {
  const entries: FamilyMapEntry[] = [];

  const persons = db.prepare(`
    SELECT id, birth_date, death_date, birthplace, death_place, birth_lat, birth_lng, death_lat, death_lng
    FROM family_tree_persons
  `).all() as Pick<FamilyTreePersonRow,
    "id" | "birth_date" | "death_date" | "birthplace" | "death_place" | "birth_lat" | "birth_lng" | "death_lat" | "death_lng">[];
  for (const person of persons) {
    if (person.birthplace && person.birth_lat != null && person.birth_lng != null) {
      entries.push({
        id: `birth:${person.id}`, kind: "birth", personIds: [person.id], place: person.birthplace,
        lat: person.birth_lat, lng: person.birth_lng, date: person.birth_date, endDate: null, eventType: null, label: null
      });
    }
    if (person.death_place && person.death_lat != null && person.death_lng != null) {
      entries.push({
        id: `death:${person.id}`, kind: "death", personIds: [person.id], place: person.death_place,
        lat: person.death_lat, lng: person.death_lng, date: person.death_date, endDate: null, eventType: null, label: null
      });
    }
  }

  const unions = db.prepare(`
    SELECT id, person1_id, person2_id, married_date, married_place, married_lat, married_lng
    FROM family_tree_unions
    WHERE married_place IS NOT NULL AND married_lat IS NOT NULL AND married_lng IS NOT NULL
  `).all() as Pick<FamilyTreeUnionRow, "id" | "person1_id" | "person2_id" | "married_date" | "married_place" | "married_lat" | "married_lng">[];
  for (const union of unions) {
    entries.push({
      id: `marriage:${union.id}`, kind: "marriage",
      personIds: [union.person1_id, union.person2_id].filter((id): id is string => id != null),
      place: union.married_place!, lat: union.married_lat!, lng: union.married_lng!,
      date: union.married_date, endDate: null, eventType: null, label: null
    });
  }

  const events = db.prepare(`
    SELECT id, person_id, type, label, date, end_date, place, place_lat, place_lng
    FROM family_tree_events
    WHERE place IS NOT NULL AND place_lat IS NOT NULL AND place_lng IS NOT NULL
  `).all() as Pick<FamilyTreeEventRow, "id" | "person_id" | "type" | "label" | "date" | "end_date" | "place" | "place_lat" | "place_lng">[];
  for (const event of events) {
    entries.push({
      id: `event:${event.id}`, kind: "event", personIds: [event.person_id],
      place: event.place!, lat: event.place_lat!, lng: event.place_lng!,
      date: event.date, endDate: event.end_date, eventType: event.type, label: event.label
    });
  }

  // Oldest first; undated after the dated, so a place's list reads as a history.
  entries.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.id.localeCompare(b.id));

  const { unpinned } = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM family_tree_persons WHERE TRIM(COALESCE(birthplace, '')) <> '' AND birth_lat IS NULL)
      + (SELECT COUNT(*) FROM family_tree_persons WHERE TRIM(COALESCE(death_place, '')) <> '' AND death_lat IS NULL)
      + (SELECT COUNT(*) FROM family_tree_unions WHERE TRIM(COALESCE(married_place, '')) <> '' AND married_lat IS NULL)
      + (SELECT COUNT(*) FROM family_tree_events WHERE TRIM(COALESCE(place, '')) <> '' AND place_lat IS NULL)
      AS unpinned
  `).get() as { unpinned: number };

  return { entries, unpinned };
}
