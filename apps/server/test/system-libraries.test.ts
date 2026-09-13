import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { runMigrationsFrom } from "../src/db/migrate.js";
import { resolveGalleryBrowseLibraryIds, resolveGalleryScopeLibraryIds } from "../src/modules/library/gallery/catalog-scope.js";
import { getHouseLibrary, setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import { registerGalleryLibraryRoutes } from "../src/modules/library/gallery/library-routes.js";
import {
  galleryLibrariesLeftOutOfScope,
  libraryRole,
  photoInboxLibraryIds,
  setSystemLibraryRole,
  systemLibraryId
} from "../src/modules/library/gallery/system-libraries.js";
import { bootApp } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

// System libraries (docs/system-data-plan.md, phase 1): the Photo Inbox and App
// files are the gallery libraries holding `libraries.role`. Migration 75 carries
// the old Inbox flag and the house_library setting onto the role; the gallery
// leaves both out of browsing; and neither can be deleted or renamed by hand.

const ADMIN = { id: "admin", role: "admin" };

describe("migration 75 carries the old answers onto the role", () => {
  // A hand-made database at schema 74: just the columns the migration reads.
  function legacyDb(settings: Record<string, unknown>, libraries: { id: string; source?: string; policy: object; created?: string; type?: string }[]) {
    const scratch = new Database(":memory:");
    scratch.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT);
      CREATE TABLE libraries (id TEXT PRIMARY KEY, type TEXT NOT NULL, source_path TEXT NOT NULL, policy_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    `);
    for (const [key, value] of Object.entries(settings)) {
      scratch.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
    }
    for (const library of libraries) {
      scratch.prepare("INSERT INTO libraries (id, type, source_path, policy_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(library.id, library.type ?? "gallery", library.source ?? `/media/${library.id}`, JSON.stringify(library.policy), library.created ?? "2026-01-01");
    }
    return scratch;
  }
  const rolesOf = (scratch: Database.Database) =>
    Object.fromEntries((scratch.prepare("SELECT id, role FROM libraries ORDER BY id").all() as { id: string; role: string | null }[]).map((row) => [row.id, row.role]));
  const policiesOf = (scratch: Database.Database) =>
    (scratch.prepare("SELECT policy_json FROM libraries").all() as { policy_json: string }[]).map((row) => JSON.parse(row.policy_json) as Record<string, unknown>);

  it("gives the Inbox and the nominated library their roles, and strips the flag", () => {
    const scratch = legacyDb({ house_library: { libraryId: "house" } }, [
      { id: "box", policy: { mode: "managed", inbox: true, maxUploadMB: 5 } },
      { id: "house", policy: { mode: "managed" } },
      { id: "photos", policy: { mode: "managed" } }
    ]);
    runMigrationsFrom(scratch, 74);
    expect(rolesOf(scratch)).toEqual({ box: "inbox", house: "app-files", photos: null });
    expect(policiesOf(scratch).every((policy) => !("inbox" in policy))).toBe(true);
    expect(policiesOf(scratch)).toContainEqual({ mode: "managed", maxUploadMB: 5 });
  });

  it("with several Inboxes keeps the one inside App storage, else the oldest", () => {
    const inApp = legacyDb({ app_storage: { path: "/media/app", rooms: {} } }, [
      { id: "old", policy: { inbox: true }, created: "2025-01-01" },
      { id: "app", source: "/media/app/Photo Inbox", policy: { inbox: true }, created: "2026-01-01" }
    ]);
    runMigrationsFrom(inApp, 74);
    expect(rolesOf(inApp)).toEqual({ app: "inbox", old: null });

    const oldest = legacyDb({}, [
      { id: "b", policy: { inbox: true }, created: "2026-02-01" },
      { id: "a", policy: { inbox: true }, created: "2026-03-01" }
    ]);
    runMigrationsFrom(oldest, 74);
    expect(rolesOf(oldest)).toEqual({ a: null, b: "inbox" });
  });

  it("leaves everything ordinary when nothing was chosen, and ignores a stale or clashing nomination", () => {
    const nothing = legacyDb({}, [{ id: "photos", policy: {} }]);
    runMigrationsFrom(nothing, 74);
    expect(rolesOf(nothing)).toEqual({ photos: null });

    const clash = legacyDb({ house_library: { libraryId: "box" } }, [{ id: "box", policy: { inbox: true } }]);
    runMigrationsFrom(clash, 74);
    expect(rolesOf(clash)).toEqual({ box: "inbox" });

    const stale = legacyDb({ house_library: { libraryId: "gone" } }, [{ id: "photos", policy: {} }]);
    runMigrationsFrom(stale, 74);
    expect(rolesOf(stale)).toEqual({ photos: null });
  });

  it("runs twice without changing its answer, and a second holder is refused by the index", () => {
    const scratch = legacyDb({ house_library: { libraryId: "house" } }, [
      { id: "box", policy: { inbox: true } },
      { id: "house", policy: {} }
    ]);
    runMigrationsFrom(scratch, 74);
    runMigrationsFrom(scratch, 74);
    expect(rolesOf(scratch)).toEqual({ box: "inbox", house: "app-files" });
    expect(() => scratch.prepare("UPDATE libraries SET role = 'inbox' WHERE id = 'house'").run()).toThrow();
  });
});

describe("the gallery's two scopes", () => {
  beforeEach(() => {
    resetDb();
    makeUser("admin", "admin");
    for (const [id, role] of [["PHOTOS", undefined], ["INBOX", "inbox"], ["FILES", "app-files"]] as const) {
      makeLibrary(id, { createdBy: "admin", type: "gallery", role });
      grant("group", EVERYONE_GROUP_ID, id, "member");
    }
  });

  it("reaches App files but not the Inbox, and browses neither unless named", () => {
    expect(resolveGalleryScopeLibraryIds(ADMIN).sort()).toEqual(["FILES", "PHOTOS"]);
    expect(resolveGalleryBrowseLibraryIds(ADMIN)).toEqual(["PHOTOS"]);
    expect(resolveGalleryBrowseLibraryIds(ADMIN, ["FILES"])).toEqual(["FILES"]);
    expect(galleryLibrariesLeftOutOfScope()).toEqual(new Set(["INBOX", "FILES"]));
    expect(photoInboxLibraryIds()).toEqual(new Set(["INBOX"]));
  });

  it("App files is the library holding the role, and a library holds one role at most", () => {
    expect(getHouseLibrary()?.id).toBe("FILES");
    expect(setHouseLibrary("INBOX", "admin")).toMatchObject({ ok: false, status: 409 });
    expect(setHouseLibrary("PHOTOS", "admin")).toMatchObject({ ok: true, library: { id: "PHOTOS" } });
    expect(libraryRole("FILES")).toBeNull();
    setSystemLibraryRole("inbox", "PHOTOS");
    expect(systemLibraryId("inbox")).toBe("PHOTOS");
    expect(libraryRole("INBOX")).toBeNull();
    expect(getHouseLibrary()).toBeNull();
  });
});

describe("the library routes leave a system library alone", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;

  beforeEach(async () => {
    resetDb();
    makeUser("admin", "admin");
    makeLibrary("INBOX", { createdBy: "admin", type: "gallery", role: "inbox" });
    makeLibrary("PHOTOS", { createdBy: "admin", type: "gallery" });
    ({ app, signIn } = await bootApp({ afterRegister: (instance) => registerGalleryLibraryRoutes(instance) }));
  });

  it("refuses to delete it, and deletes an ordinary one", async () => {
    const cookie = await signIn("admin");
    const refused = await app.inject({ method: "DELETE", url: "/api/library/gallery-libraries/INBOX", headers: { cookie } });
    expect(refused.statusCode).toBe(409);
    expect(db.prepare("SELECT 1 FROM libraries WHERE id = 'INBOX'").get()).toBeTruthy();

    const deleted = await app.inject({ method: "DELETE", url: "/api/library/gallery-libraries/PHOTOS", headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
  });

  it("refuses a new name but takes an access change", async () => {
    const cookie = await signIn("admin");
    const renamed = await app.inject({ method: "PATCH", url: "/api/library/gallery-libraries/INBOX", headers: { cookie }, payload: { name: "Scans" } });
    expect(renamed.statusCode).toBe(409);

    const access = await app.inject({ method: "PATCH", url: "/api/library/gallery-libraries/INBOX", headers: { cookie }, payload: { name: "INBOX", visibility: "private" } });
    expect(access.statusCode).toBe(200);
    expect(access.json().library).toMatchObject({ role: "inbox", inbox: true, visibility: "private" });
  });
});
