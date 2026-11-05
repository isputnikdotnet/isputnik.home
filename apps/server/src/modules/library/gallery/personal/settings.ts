// The admin's settings for personal libraries (docs/photo-sync-plan.md, decision 4),
// kept in one app_settings row. Off by default: nothing changes on an install until an
// admin turns them on, names who may have one, and picks where they are created.
import path from "node:path";
import { z } from "zod";
import { db } from "../../../../db.js";
import { EVERYONE_GROUP_ID } from "../../../../core/permissions.js";
import type { AppSettingRow, GroupMemberRow, StorageRootRow } from "../../../../db/rows.js";

const KEY = "personal_libraries";

export const DEFAULT_PERSONAL_FOLDER = "Personal";
/** The largest size limit the form takes, in GB (10 TB). */
export const MAX_SIZE_LIMIT_GB = 10_240;

const subjectSchema = z.object({
  type: z.enum(["user", "group"]),
  id: z.string().trim().min(1).max(64)
});

export const personalSettingsSchema = z.object({
  enabled: z.boolean(),
  /** A storage container (storage_roots.id) the libraries are created under. */
  storageRootId: z.string().trim().min(1).max(64).nullable(),
  /** A folder inside that container, relative; created when the first library is. */
  folder: z.string().trim().min(1).max(200),
  /** Everyone signed in, or only the members and groups listed. */
  who: z.enum(["everyone", "chosen"]),
  subjects: z.array(subjectSchema).max(200),
  /** Per member, in GB; null = no limit. */
  sizeLimitGB: z.number().positive().max(MAX_SIZE_LIMIT_GB).nullable()
});

export type PersonalSettings = z.infer<typeof personalSettingsSchema>;

const DEFAULTS: PersonalSettings = {
  enabled: false,
  storageRootId: null,
  folder: DEFAULT_PERSONAL_FOLDER,
  who: "everyone",
  subjects: [],
  sizeLimitGB: null
};

export function getPersonalSettings(): PersonalSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    const parsed = personalSettingsSchema.safeParse({ ...DEFAULTS, ...(JSON.parse(row.value) as object) });
    return parsed.success ? parsed.data : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePersonalSettings(settings: PersonalSettings, userId: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(KEY, JSON.stringify(settings), userId);
}

/** A folder name the settings accept: relative, no `..`, no hidden segment. Returns
 *  it with forward slashes, or null. */
export function normalisePersonalFolder(value: string): string | null {
  const parts = value.split(String.fromCharCode(92)).join("/").split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return null;
  if (parts.some((part) => part === "." || part === ".." || part.startsWith("."))) return null;
  return parts.join("/");
}

/** The absolute folder personal libraries are created in, or null when no container
 *  is chosen (or the chosen one is gone). */
export function personalParentFolder(settings: PersonalSettings = getPersonalSettings()): string | null {
  if (!settings.storageRootId) return null;
  const root = db.prepare("SELECT path FROM storage_roots WHERE id = ?").get(settings.storageRootId) as Pick<StorageRootRow, "path"> | undefined;
  if (!root) return null;
  const folder = normalisePersonalFolder(settings.folder) ?? DEFAULT_PERSONAL_FOLDER;
  return path.join(root.path, ...folder.split("/"));
}

/** Whether the settings let `user` have a personal library (not whether they have one). */
export function isAllowedPersonalLibrary(user: { id: string }, settings: PersonalSettings = getPersonalSettings()): boolean {
  if (!settings.enabled) return false;
  if (settings.who === "everyone") return true;
  if (settings.subjects.some((s) => s.type === "user" && s.id === user.id)) return true;
  const groups = new Set((db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(user.id) as Pick<GroupMemberRow, "group_id">[])
    .map((row) => row.group_id));
  groups.add(EVERYONE_GROUP_ID);
  return settings.subjects.some((s) => s.type === "group" && groups.has(s.id));
}

export function sizeLimitBytes(settings: PersonalSettings = getPersonalSettings()): number | null {
  return settings.sizeLimitGB == null ? null : Math.round(settings.sizeLimitGB * 1024 ** 3);
}
