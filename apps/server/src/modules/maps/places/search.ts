// A place name to coordinates, from the places database (the reverse of namer.ts).
//
// Review mode's "Where?" offers towns while she types "Minsk, Belarus", so a place
// written in words can also put the photo on the map. It is offline on purpose:
// OpenStreetMap's public geocoder forbids search-as-you-type, and nothing she
// types needs to leave the house to find a town the server already knows.
//
// What it can find is what the database holds — populated places of 500+ people,
// in their own spelling and in English and Russian — plus, for the countries an
// admin asked for "every village in", every village of theirs, however small.
// Villages come after towns (a town called exactly that still leads) and carry
// their district, so three Veselovkas in one region read apart. A street is never
// here; Review mode offers the online lookup for those, as a button.
//
// The database is read-only and has no index on names: a prefix scan of both name
// columns measured ~20 ms on the full data, which a debounced search affords.
import type Database from "better-sqlite3";
import { NAME_LANGUAGES, openPlaces, searchKey, searchKeyCeiling } from "./dataset.js";
import { geoNamesNamer } from "./namer.js";

export interface PlaceSuggestion {
  label: string;
  lat: number;
  lng: number;
}

const MAX_RESULTS = 8;
/** Rows read per name column before the qualifiers ("…, Belarus") filter them. */
const CANDIDATES = 60;

const NEVER_SQL = "('PPLX','PPLH','PPLQ','PPLW','PPLCH')";

/** LIKE's own wildcards, taken literally. */
function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** SQLite's LIKE folds case for ASCII only, so a Cyrillic "минск" would miss
 *  "Минск": ask for the words as typed and with each word capitalised. */
function spellings(text: string): [string, string] {
  const capitalised = text.replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, letter: string) => `${gap}${letter.toLocaleUpperCase()}`);
  return [likePrefix(text), likePrefix(capitalised)];
}

const fold = searchKey;

function countryNames(code: string): string[] {
  const names = [code];
  for (const language of NAME_LANGUAGES) {
    try {
      const name = new Intl.DisplayNames([language], { type: "region" }).of(code);
      if (name) names.push(name);
    } catch {
      // An unknown code names nothing.
    }
  }
  return names.map(fold);
}

/** Prepared once per connection; a rebuilt database is a new connection. */
interface Statements {
  own: Database.Statement;
  translated: Database.Statement;
  /** Absent on a database built before villages existed. */
  villages: Database.Statement | null;
  translatedVillages: Database.Statement | null;
  /** The folded-spelling index; absent on a database built before it. */
  keys: Database.Statement | null;
  placeRow: Database.Statement;
  villageRow: Database.Statement | null;
}
const statements = new WeakMap<Database.Database, Statements>();

function statementsFor(db: Database.Database) {
  let prepared = statements.get(db);
  if (!prepared) {
    prepared = {
      own: db.prepare(`
        SELECT id, name, lat, lng, country, population FROM places
        WHERE (name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') AND fcode NOT IN ${NEVER_SQL}
        ORDER BY population DESC LIMIT ${CANDIDATES}
      `),
      translated: db.prepare(`
        SELECT p.id, n.name, p.lat, p.lng, p.country, p.population FROM names n JOIN places p ON p.id = n.id
        WHERE (n.name LIKE ? ESCAPE '\\' OR n.name LIKE ? ESCAPE '\\') AND p.fcode NOT IN ${NEVER_SQL}
        ORDER BY p.population DESC LIMIT ${CANDIDATES}
      `),
      villages: null,
      translatedVillages: null,
      keys: null,
      placeRow: db.prepare(`SELECT id, name, lat, lng, country, population FROM places WHERE id = ? AND fcode NOT IN ${NEVER_SQL}`),
      villageRow: null
    };
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'place_search'").get()) {
      prepared.keys = db.prepare(`SELECT DISTINCT id, village FROM place_search WHERE key >= ? AND key < ? LIMIT ${CANDIDATES * 4}`);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'villages'").get()) {
      prepared.villages = db.prepare(`
        SELECT id, name, lat, lng, country, population FROM villages
        WHERE (name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
        ORDER BY population DESC LIMIT ${CANDIDATES}
      `);
      prepared.translatedVillages = db.prepare(`
        SELECT v.id, n.name, v.lat, v.lng, v.country, v.population FROM names n JOIN villages v ON v.id = n.id
        WHERE (n.name LIKE ? ESCAPE '\\' OR n.name LIKE ? ESCAPE '\\')
        ORDER BY v.population DESC LIMIT ${CANDIDATES}
      `);
      prepared.villageRow = db.prepare("SELECT id, name, lat, lng, country, population FROM villages WHERE id = ?");
    }
    statements.set(db, prepared);
  }
  return prepared;
}

interface Row {
  id: number;
  name: string;
  lat: number;
  lng: number;
  country: string;
  population: number;
}

/** Towns whose name starts with the first part of `query`; any further parts
 *  ("Minsk, Belarus") must match the town's region or country. Labelled in
 *  `language`, most populous first. Empty when there is no places database. */
export function suggestPlaces(query: string, language: string): PlaceSuggestion[] {
  const db = openPlaces();
  const namer = geoNamesNamer();
  if (!db || !namer) return [];
  const [head, ...rest] = query.split(",").map((part) => part.trim()).filter(Boolean);
  if (!head || head.length < 2) return [];
  const qualifiers = rest.map(fold);

  const [asTyped, capitalised] = spellings(head);
  const prepared = statementsFor(db);
  const own = prepared.own.all(asTyped, capitalised) as Row[];
  const translated = prepared.translated.all(asTyped, capitalised) as Row[];
  const villageRows = [
    ...((prepared.villages?.all(asTyped, capitalised) ?? []) as Row[]),
    ...((prepared.translatedVillages?.all(asTyped, capitalised) ?? []) as Row[])
  ];
  // Folded spellings: "Veselovka" finds "Vesëlovka", "веселовка" finds "Весёловка",
  // and a village is found by any name GeoNames lists for it.
  const key = searchKey(head);
  for (const hit of (prepared.keys?.all(key, searchKeyCeiling(key)) ?? []) as { id: number; village: number }[]) {
    const row = (hit.village ? prepared.villageRow?.get(hit.id) : prepared.placeRow.get(hit.id)) as Row | undefined;
    if (!row) continue;
    if (hit.village) villageRows.push(row);
    else own.push(row);
  }

  const wanted = fold(head);
  const byId = new Map<number, Row & { exact: boolean; village: boolean }>();
  for (const [row, village] of [...own.map((r) => [r, false] as const), ...translated.map((r) => [r, false] as const), ...villageRows.map((r) => [r, true] as const)]) {
    const exact = fold(row.name) === wanted;
    const seen = byId.get(row.id);
    if (!seen || (exact && !seen.exact)) byId.set(row.id, { ...row, exact, village });
  }

  // GeoNames files Paris's arrondissements as towns ("Paris 16 Passy"); with Paris
  // itself on the list they are six copies of it. A numbered part is left off when
  // its whole is offered too (the same rule namer.ts names points by).
  const rows = [...byId.values()];
  const isPartOfListed = (row: Row) => rows.some((whole) =>
    whole.id !== row.id && whole.country === row.country && whole.population > row.population
    && row.name.startsWith(`${whole.name} `) && /^[0-9]/.test(row.name.slice(whole.name.length + 1)));

  const results: (PlaceSuggestion & { exact: boolean; population: number; village: boolean })[] = [];
  for (const row of rows) {
    if (isPartOfListed(row)) continue;
    const described = namer.describe(row.id, language);
    if (!described) continue;
    if (qualifiers.length > 0) {
      const english = language === "en" ? described : namer.describe(row.id, "en");
      const haystack = [
        ...countryNames(row.country),
        fold(described.region ?? ""),
        fold(english?.region ?? ""),
        fold(described.district ?? ""),
        fold(english?.district ?? "")
      ].filter(Boolean);
      const matches = qualifiers.every((qualifier) => haystack.some((name) => name.startsWith(qualifier) || name.includes(qualifier)));
      if (!matches) continue;
    }
    const label = [described.place, described.district, described.region, described.country].filter(Boolean).join(", ");
    results.push({ label, lat: row.lat, lng: row.lng, exact: row.exact, population: row.population, village: row.village });
  }

  // A place called exactly what she typed first — a town before a village of the
  // same name — then the bigger places.
  results.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(a.village) - Number(b.village) || b.population - a.population);
  return results.slice(0, MAX_RESULTS).map(({ label, lat, lng }) => ({ label, lat, lng }));
}
