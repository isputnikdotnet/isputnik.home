// "Preview as …" (core/preview.ts): an admin sees the app as one member,
// read-only — the member's scope everywhere, nothing written, nothing logged in
// their name, and only an admin can start it.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { authPlugin } from "../src/core/auth-routes.js";
import { galleryRoutesPlugin } from "../src/modules/library/gallery/routes.js";
import { galleryPeopleAccessRoutesPlugin } from "../src/modules/library/gallery/people-access-routes.js";
import { setPersonGrant } from "../src/modules/library/gallery/people-access.js";
import { bootApp, cookiesFrom } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

function photo(id: string, personId: string | null) {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'fam', 'gallery', ?, 'ready')").run(id, `Private/${id}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 1)").run(id, `Private/${id}.jpg`);
  if (personId) {
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, assignment, source) VALUES (?, ?, ?, 'confirmed', 'manual')").run(`f-${id}`, id, personId);
  }
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("admin2", "admin");
  makeUser("cousin", "member");
  makeLibrary("fam", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  grant("user", "admin", "fam", "manager");
  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('ivan', 'Ivan')").run();
  photo("p1", "ivan");
  photo("p2", null);
  setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", true, "admin");
  ({ app, signIn } = await bootApp({ plugins: [authPlugin, galleryRoutesPlugin, galleryPeopleAccessRoutesPlugin] }));
});

afterEach(async () => { await app.close(); });

async function startPreview(adminCookie: string, userId: string) {
  const res = await app.inject({ method: "POST", url: "/api/preview", headers: { cookie: adminCookie }, payload: { userId } });
  return { res, cookie: `${adminCookie}; ${cookiesFrom(res)}` };
}

const timeline = (cookie: string) => app.inject({
  method: "POST", url: "/api/library/gallery/timeline", headers: { cookie }, payload: { q: "", kinds: [], limit: 20, offset: 0 }
});

describe("previewing as a member", () => {
  it("answers every read as the member, and says who is looking", async () => {
    const admin = await signIn("admin");
    expect((await timeline(admin)).json().assets.map((a: { id: string }) => a.id).sort()).toEqual(["p1", "p2"]);
    const { res, cookie } = await startPreview(admin, "cousin");
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().user).toMatchObject({ id: "cousin", role: "member", previewBy: { id: "admin" } });
    // The cousin's Gallery: the shared photo only, redacted as the cousin sees it.
    const list = (await timeline(cookie)).json().assets;
    expect(list.map((a: { id: string }) => a.id)).toEqual(["p1"]);
    expect(list[0]).toMatchObject({ folderPath: "p1.jpg", libraryName: null });
    // And admin-only routes are closed, as they are to the cousin.
    expect((await app.inject({ method: "GET", url: "/api/library/gallery/access/user/cousin", headers: { cookie } })).statusCode).toBe(403);
  });

  it("is read-only, logs nothing as the member, and stops from inside", async () => {
    const { cookie } = await startPreview(await signIn("admin"), "cousin");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM activity_logs").get() as { n: number }).n;
    const write = await app.inject({ method: "PUT", url: "/api/library/gallery/assets/p1/share-exclusion", headers: { cookie } });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ preview: true });
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_logs").get() as { n: number }).n).toBe(before);

    const stop = await app.inject({ method: "DELETE", url: "/api/preview", headers: { cookie } });
    expect(stop.json()).toMatchObject({ stopped: true, userId: "cousin" });
    expect(String(stop.headers["set-cookie"])).toMatch(/isputnik_preview=;/);
  });

  it("only an admin starts it, only for an active member, and a stray cookie gives nothing", async () => {
    const cousin = await signIn("cousin");
    expect((await app.inject({ method: "POST", url: "/api/preview", headers: { cookie: cousin }, payload: { userId: "cousin" } })).statusCode).toBe(403);
    const admin = await signIn("admin");
    expect((await startPreview(admin, "admin2")).res.statusCode).toBe(400);
    expect((await startPreview(admin, "nobody")).res.statusCode).toBe(404);
    // A member holding a preview cookie (copied, or left over) is just themselves.
    const forged = `${cousin}; isputnik_preview=admin`;
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: forged } });
    expect(me.json().user).toMatchObject({ id: "cousin", previewBy: null });
    // The start is logged, as the admin.
    await startPreview(admin, "cousin");
    expect(db.prepare("SELECT actor_user_id, target_id FROM activity_logs WHERE event = 'auth.preview.started'").all()).toEqual([
      { actor_user_id: "admin", target_id: "cousin" }
    ]);
  });
});
