// Viewing profiles (docs/tv-profiles-plan.md): views of ONE account for a shared
// screen — Kids, Russian, Classic. A profile belongs to the account that made it,
// is worn by a session (sessions.profile_id), and only ever NARROWS what that
// account sees:
//   - libraries: a subset of the owner's video libraries, intersected with the
//     owner's own access on every request, never stored as a grant;
//   - sections: a subset of the household's sections;
//   - rows: its own video page (home-layout.ts reads them), or the owner's.
// `restricted` marks a profile that will be locked to leave (phase P2); in P1 it
// only changes what the profile defaults to.
import type { FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db.js";
import { SECTION_KEYS, getSections, type SectionKey, type Sections } from "../../core/sections.js";
import { currentRequest } from "../../core/viewer-context.js";
import { accessibleLibraryIds } from "../library/shared/library-access.js";

/** Enough for a family; more is a list nobody picks from with a remote. */
export const PROFILES_MAX = 8;

/** The avatars every screen can draw: a colour each, with the name's first letter. */
export const PROFILE_AVATARS = ["blue", "green", "orange", "pink", "purple", "teal", "red", "yellow"] as const;
export type ProfileAvatar = (typeof PROFILE_AVATARS)[number];

const VIDEO = "video";

interface ProfileRow {
  id: string;
  user_id: string;
  name: string;
  avatar: string;
  position: number;
  restricted: number;
  libraries: string | null;
  sections: string | null;
  rows: string | null;
}

export interface ViewingProfile {
  id: string;
  userId: string;
  name: string;
  avatar: ProfileAvatar;
  position: number;
  restricted: boolean;
  /** null: every video library the owner may see. */
  libraries: string[] | null;
  /** null: every section the household has on. */
  sections: SectionKey[] | null;
  /** Whether it has a video page of its own (else the owner's). */
  ownRows: boolean;
}

const stringArray = (json: string | null): string[] | null => {
  if (json == null) return null;
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;
  } catch {
    // Unreadable is read as the narrowest answer, not the widest: nothing.
    return [];
  }
};

function fromRow(row: ProfileRow): ViewingProfile {
  const sections = stringArray(row.sections);
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    avatar: (PROFILE_AVATARS as readonly string[]).includes(row.avatar) ? (row.avatar as ProfileAvatar) : "blue",
    position: row.position,
    restricted: row.restricted === 1,
    libraries: stringArray(row.libraries),
    sections: sections === null ? null : sections.filter((key): key is SectionKey => (SECTION_KEYS as readonly string[]).includes(key)),
    ownRows: row.rows !== null
  };
}

export function listProfiles(userId: string): ViewingProfile[] {
  return (db.prepare("SELECT * FROM viewing_profiles WHERE user_id = ? ORDER BY position, created_at").all(userId) as ProfileRow[]).map(fromRow);
}

/** One of this account's profiles, or null — never another account's. */
export function getProfile(id: string, userId: string): ViewingProfile | null {
  const row = db.prepare("SELECT * FROM viewing_profiles WHERE id = ? AND user_id = ?").get(id, userId) as ProfileRow | undefined;
  return row ? fromRow(row) : null;
}

export const profileInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  avatar: z.enum(PROFILE_AVATARS),
  restricted: z.boolean().default(false),
  libraries: z.array(z.string().min(1).max(64)).max(50).nullable().default(null),
  sections: z.array(z.enum(SECTION_KEYS)).max(SECTION_KEYS.length).nullable().default(null)
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

/** What a restricted profile shows when nobody chose: Video alone. */
const RESTRICTED_SECTIONS: SectionKey[] = ["video"];

/** Libraries the owner can't see aren't kept: a profile is never a way to name one. */
function ownedLibraries(libraries: string[] | null, user: { id: string; role: string }): string[] | null {
  if (libraries === null) return null;
  const allowed = accessibleLibraryIds(user.id, user.role, VIDEO);
  return [...new Set(libraries)].filter((id) => allowed.has(id));
}

export function createProfile(input: ProfileInput, user: { id: string; role: string }): ViewingProfile {
  const id = nanoid();
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM viewing_profiles WHERE user_id = ?").get(user.id) as { next: number }).next;
  const sections = input.sections ?? (input.restricted ? RESTRICTED_SECTIONS : null);
  const libraries = ownedLibraries(input.libraries, user);
  db.prepare(`
    INSERT INTO viewing_profiles (id, user_id, name, avatar, position, restricted, libraries, sections)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.id, input.name, input.avatar, position, input.restricted ? 1 : 0,
    libraries === null ? null : JSON.stringify(libraries), sections === null ? null : JSON.stringify(sections));
  return getProfile(id, user.id)!;
}

export function updateProfile(id: string, input: ProfileInput, user: { id: string; role: string }): ViewingProfile | null {
  const libraries = ownedLibraries(input.libraries, user);
  const result = db.prepare(`
    UPDATE viewing_profiles
    SET name = ?, avatar = ?, restricted = ?, libraries = ?, sections = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND user_id = ?
  `).run(input.name, input.avatar, input.restricted ? 1 : 0,
    libraries === null ? null : JSON.stringify(libraries), input.sections === null ? null : JSON.stringify(input.sections), id, user.id);
  return result.changes > 0 ? getProfile(id, user.id) : null;
}

/** Deleting drops every session in it back to the account (ON DELETE SET NULL). */
export function deleteProfile(id: string, userId: string): boolean {
  return db.prepare("DELETE FROM viewing_profiles WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/** The order the screens show them in; ids not this account's are ignored. */
export function reorderProfiles(ids: string[], userId: string): void {
  const update = db.prepare("UPDATE viewing_profiles SET position = ? WHERE id = ? AND user_id = ?");
  db.transaction(() => ids.forEach((id, index) => update.run(index, id, userId)))();
}

export function setSessionProfile(sessionId: string, profileId: string | null): void {
  db.prepare("UPDATE sessions SET profile_id = ? WHERE id = ?").run(profileId, sessionId);
}

// ── A profile's own video page (home-layout.ts parses the rows) ─────────────

export function getProfileRowsJson(id: string, userId: string): string | null {
  const row = db.prepare("SELECT rows FROM viewing_profiles WHERE id = ? AND user_id = ?").get(id, userId) as { rows: string | null } | undefined;
  return row?.rows ?? null;
}

/** null: the profile follows its owner's page again. */
export function setProfileRowsJson(id: string, userId: string, rows: string | null): boolean {
  return db.prepare("UPDATE viewing_profiles SET rows = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND user_id = ?")
    .run(rows, id, userId).changes > 0;
}

// ── What the profile being worn changes ─────────────────────────────────────

/** The profile a request's session wears, or null. Kept on the request, so a
 *  hook (which runs before the handler's viewer context exists) asks once too. */
const worn = new WeakMap<FastifyRequest, ViewingProfile | null>();
export function currentProfileOf(request: FastifyRequest | null | undefined): ViewingProfile | null {
  if (!request?.profileId || !request.user) return null;
  if (worn.has(request)) return worn.get(request)!;
  const profile = getProfile(request.profileId, request.user.id);
  worn.set(request, profile);
  return profile;
}

/** The profile the current request's session wears, or null. */
export function currentProfile(): ViewingProfile | null {
  return currentProfileOf(currentRequest());
}

/** The household's sections, less what the profile leaves out. */
export function effectiveSections(profile: ViewingProfile | null, household: Sections = getSections()): Sections {
  if (!profile?.sections) return household;
  const allowed = new Set(profile.sections);
  return Object.fromEntries(Object.entries(household).map(([key, on]) => [key, on && allowed.has(key as SectionKey)])) as Sections;
}

/** The video libraries this person may see, narrowed by the profile they wear.
 *  Every answer about video access goes through this one function. */
export function visibleVideoLibraryIds(user: { id: string; role: string }, request?: FastifyRequest): Set<string> {
  const own = accessibleLibraryIds(user.id, user.role, VIDEO);
  const profile = request ? currentProfileOf(request) : currentProfile();
  if (!profile || profile.userId !== user.id) return own;
  if (!effectiveSections(profile).video) return new Set();
  if (profile.libraries === null) return own;
  const allowed = new Set(profile.libraries);
  return new Set([...own].filter((id) => allowed.has(id)));
}
