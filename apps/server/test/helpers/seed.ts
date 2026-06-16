// Test seeding helpers. Importing src/db.js opens the in-memory database (see
// vitest.config.ts) and builds the full schema, so these write straight into the
// real tables the access-control code reads.
import { db } from "../../src/db.js";

type ObjectRole = "viewer" | "member" | "contributor" | "manager" | "deny";

// Clear every table the access tests touch. FKs are toggled off so order and the
// created_by/owner references don't matter — each test starts from empty.
export function resetDb(): void {
  db.pragma("foreign_keys = OFF");
  const tables = [
    "assignments", "group_members", "shares", "share_links",
    "item_saves", "item_categories", "item_people", "series_items",
    "audio_chapters", "audio_files", "document_files",
    "playback_progress", "track_progress", "reading_progress",
    "audio_bookmarks", "reading_bookmarks",
    "audiobook_details", "ebook_details", "item_metadata",
    "taggables", "collection_items", "collections",
    "library_items", "people", "series", "libraries", "user_groups", "users"
  ];
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.pragma("foreign_keys = ON");
}

export function makeUser(id: string, role: "admin" | "member" = "member"): string {
  db.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, 'x', ?, ?)"
  ).run(id, `${id}@test.local`, id, role);
  return id;
}

export function makeGroup(id: string, createdBy: string): string {
  db.prepare("INSERT INTO user_groups (id, name, created_by) VALUES (?, ?, ?)").run(id, id, createdBy);
  return id;
}

export function addToGroup(groupId: string, userId: string): void {
  db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").run(groupId, userId);
}

export function grant(
  subjectType: "user" | "group",
  subjectId: string,
  objectId: string,
  role: ObjectRole,
  objectType = "library"
): void {
  db.prepare(
    "INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role) VALUES (?, ?, ?, ?, ?)"
  ).run(subjectType, subjectId, objectType, objectId, role);
}

export function makeLibrary(
  id: string,
  opts: { createdBy: string; type?: string; policyJson?: string; ownerId?: string; ownerType?: "user" | "group" }
): string {
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json, owner_id, owner_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, id, opts.type ?? "audiobook", `/src/${id}`, opts.createdBy, opts.policyJson ?? "{}", opts.ownerId ?? null, opts.ownerType ?? null);
  return id;
}

// Insert a user-to-user item share. expiresAt: ISO string, or null for permanent.
export function makeShare(opts: {
  module: string;
  resourceId: string;
  userId: string;
  createdBy: string;
  expiresAt?: string | null;
  revoked?: boolean;
}): void {
  db.prepare(
    "INSERT INTO shares (id, module, resource_id, user_id, created_by, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    `share-${opts.resourceId}-${opts.userId}`,
    opts.module,
    opts.resourceId,
    opts.userId,
    opts.createdBy,
    opts.expiresAt ?? null,
    opts.revoked ? new Date().toISOString() : null
  );
}

export const futureIso = (ms = 3_600_000): string => new Date(Date.now() + ms).toISOString();
export const pastIso = (ms = 3_600_000): string => new Date(Date.now() - ms).toISOString();
