// The family tree's numbers for the control panel's Family Tree Overview (owner,
// 2026-11-19): how many people, couples, sources, photos and places it holds. Registered
// into the core status registry from familyTreePlugin, so core/ never touches the
// tree's tables (core/status-contributors.ts).

import { db } from "../../db.js";
import { registerStatusContributor } from "../../core/status-contributors.js";

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function familyTreeStats() {
  return {
    people: count("family_tree_persons"),
    couples: count("family_tree_unions"),
    sources: count("family_tree_sources"),
    // Photos attached to people: one photo on two people counts once.
    photos: (db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM family_tree_photos").get() as { n: number }).n,
    // Places named anywhere in the tree — births, deaths and events — each once,
    // however it was capitalised.
    places: (db.prepare(`
      SELECT COUNT(DISTINCT lower(trim(place))) AS n FROM (
        SELECT birthplace AS place FROM family_tree_persons
        UNION ALL SELECT death_place FROM family_tree_persons
        UNION ALL SELECT place FROM family_tree_events
      ) WHERE place IS NOT NULL AND trim(place) <> ''
    `).get() as { n: number }).n
  };
}

// One function for every registration: the registry refuses a second, different
// contributor for the same key, and a plugin may be registered more than once.
const contribute = () => ({ familyTreeStats: familyTreeStats() });

export function registerFamilyTreeStats(): void {
  registerStatusContributor("familyTree", ["familyTreeStats"], contribute);
}
