// Viewing profiles (docs/tv-profiles-plan.md): the household's ways of watching video
// — Kids, Russian, Classic — set up by an admin on the video page and offered on every
// TV and in every browser, Netflix-style. A profile is worn by a session
// (sessions.profile_id) and only ever NARROWS what the signed-in account sees:
//   - libraries: a subset of the video libraries, intersected with the account's own
//     access on every request, never stored as a grant;
//   - rows: its own video page (home-layout.ts reads them), or the household's.
// `restricted` marks a profile that needs the household PIN to leave (pins.ts).
// Profiles are a video thing only: the rest of the app stays the account's.
import type { FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db.js";
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
  name: string;
  avatar: string;
  position: number;
  restricted: number;
  libraries: string | null;
  rows: string | null;
}

export interface ViewingProfile {
  id: string;
  name: string;
  avatar: ProfileAvatar;
  position: number;
  restricted: boolean;
  /** null: every video library the person looking may see. */
  libraries: string[] | null;
  /** Whether it has a video page of its own (else the household's). */
  ownRows: boolean;
}

const stringArray = (json: string | null): string[] | null => {
  if (json == null) return null;
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    // Unreadable is read as the narrowest answer, not the widest: nothing.
    return [];
  }
};

function fromRow(row: ProfileRow): ViewingProfile {
  return {
    id: row.id,
    name: row.name,
    avatar: (PROFILE_AVATARS as readonly string[]).includes(row.avatar) ? (row.avatar as ProfileAvatar) : "blue",
    position: row.position,
    restricted: row.restricted === 1,
    libraries: stringArray(row.libraries),
    ownRows: row.rows !== null
  };
}

const COLUMNS = "id, name, avatar, position, restricted, libraries, rows";

export function listProfiles(): ViewingProfile[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM viewing_profiles ORDER BY position, created_at`).all() as ProfileRow[]).map(fromRow);
}

export function getProfile(id: string): ViewingProfile | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM viewing_profiles WHERE id = ?`).get(id) as ProfileRow | undefined;
  return row ? fromRow(row) : null;
}

export const profileInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  avatar: z.enum(PROFILE_AVATARS),
  restricted: z.boolean().default(false),
  libraries: z.array(z.string().min(1).max(64)).max(50).nullable().default(null)
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

/** Only video libraries are kept: a profile is never a way to name anything else. */
function videoLibraries(libraries: string[] | null): string | null {
  if (libraries === null) return null;
  const known = new Set((db.prepare("SELECT id FROM libraries WHERE type = ?").all(VIDEO) as { id: string }[]).map((row) => row.id));
  return JSON.stringify([...new Set(libraries)].filter((id) => known.has(id)));
}

export function createProfile(input: ProfileInput, createdBy: string): ViewingProfile {
  const id = nanoid();
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM viewing_profiles").get() as { next: number }).next;
  db.prepare(`
    INSERT INTO viewing_profiles (id, name, avatar, position, restricted, libraries, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.avatar, position, input.restricted ? 1 : 0, videoLibraries(input.libraries), createdBy);
  return getProfile(id)!;
}

export function updateProfile(id: string, input: ProfileInput): ViewingProfile | null {
  const result = db.prepare(`
    UPDATE viewing_profiles
    SET name = ?, avatar = ?, restricted = ?, libraries = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(input.name, input.avatar, input.restricted ? 1 : 0, videoLibraries(input.libraries), id);
  return result.changes > 0 ? getProfile(id) : null;
}

/** What else holds a profile's things and must hear it is gone (the video engine's
 *  watch history). Called after the row is deleted; a listener's failure is its own. */
const deletedListeners: ((id: string) => void)[] = [];
export function onProfileDeleted(listener: (id: string) => void): void {
  deletedListeners.push(listener);
}

/** Deleting drops every session wearing it back to its account (ON DELETE SET NULL)
 *  and its My list (ON DELETE CASCADE). */
export function deleteProfile(id: string): boolean {
  const gone = db.prepare("DELETE FROM viewing_profiles WHERE id = ?").run(id).changes > 0;
  if (gone) for (const listener of deletedListeners) listener(id);
  return gone;
}

/** The order the screens show them in; unknown ids are ignored. */
export function reorderProfiles(ids: string[]): void {
  const update = db.prepare("UPDATE viewing_profiles SET position = ? WHERE id = ?");
  db.transaction(() => ids.forEach((id, index) => update.run(index, id)))();
}

export function setSessionProfile(sessionId: string, profileId: string | null): void {
  db.prepare("UPDATE sessions SET profile_id = ? WHERE id = ?").run(profileId, sessionId);
}

// ── A profile's own video page (home-layout.ts parses the rows) ─────────────

export function getProfileRowsJson(id: string): string | null {
  const row = db.prepare("SELECT rows FROM viewing_profiles WHERE id = ?").get(id) as { rows: string | null } | undefined;
  return row?.rows ?? null;
}

/** null: the profile follows the household's page again. */
export function setProfileRowsJson(id: string, rows: string | null): boolean {
  return db.prepare("UPDATE viewing_profiles SET rows = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(rows, id).changes > 0;
}

// ── What the profile being worn changes ─────────────────────────────────────

/** The profile a request's session wears, or null. Kept on the request, so a hook
 *  (which runs before the handler's viewer context exists) asks once too. */
const worn = new WeakMap<FastifyRequest, ViewingProfile | null>();
export function currentProfileOf(request: FastifyRequest | null | undefined): ViewingProfile | null {
  if (!request?.profileId || !request.user) return null;
  if (worn.has(request)) return worn.get(request)!;
  const profile = getProfile(request.profileId);
  worn.set(request, profile);
  return profile;
}

/** The profile the current request's session wears, or null. */
export function currentProfile(): ViewingProfile | null {
  return currentProfileOf(currentRequest());
}

/** The video libraries this person may see, narrowed by the profile they wear.
 *  Every answer about video access goes through this one function. */
export function visibleVideoLibraryIds(user: { id: string; role: string }, request?: FastifyRequest): Set<string> {
  const own = accessibleLibraryIds(user.id, user.role, VIDEO);
  const viewer = request ?? currentRequest();
  // A profile narrows the session's own account, never someone else asked about.
  if (!viewer || viewer.user?.id !== user.id) return own;
  const profile = currentProfileOf(viewer);
  if (!profile || profile.libraries === null) return own;
  const allowed = new Set(profile.libraries);
  return new Set([...own].filter((id) => allowed.has(id)));
}
