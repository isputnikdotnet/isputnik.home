// The Access dialog's one read (docs/people-sharing-plan.md, phase 2) and invites
// that carry groups (D19): what a person is given directly, what they get through a
// group or the household baseline, and a relative who arrives already in a group.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { accessRoutesPlugin } from "../src/modules/users/access-routes.js";
import { invitesPlugin } from "../src/modules/users/invites.js";
import { bootApp } from "./helpers/boot.js";
import { addToGroup, grant, makeGroup, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM invites").run();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  makeGroup("petrov", "admin");
  addToGroup("petrov", "cousin");
  makeLibrary("archive", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  makeLibrary("books", { createdBy: "admin", type: "audiobook" });
  makeLibrary("inbox", { createdBy: "admin", type: "gallery", role: "inbox" });
  grant("group", "petrov", "archive", "member");
  grant("group", EVERYONE_GROUP_ID, "books", "viewer");
  ({ app, signIn } = await bootApp({ plugins: [accessRoutesPlugin, invitesPlugin] }));
});

afterEach(async () => { await app.close(); });

describe("GET /api/access/:subjectType/:subjectId", () => {
  it("shows every library with what was given directly and where the rest comes from", async () => {
    grant("user", "cousin", "books", "deny");
    const res = await app.inject({ method: "GET", url: "/api/access/user/cousin", headers: { cookie: await signIn("admin") } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subject).toMatchObject({ subjectType: "user", name: "cousin", role: "member" });
    expect(body.groups).toEqual([{ id: "petrov", name: "petrov" }]);
    // System libraries are not rows of their own.
    expect(body.libraries.map((l: { id: string }) => l.id).sort()).toEqual(["archive", "books"]);
    const archive = body.libraries.find((l: { id: string }) => l.id === "archive");
    expect(archive).toMatchObject({ direct: null, effective: "member", inherited: [{ via: "group", groupId: "petrov", role: "member" }] });
    const books = body.libraries.find((l: { id: string }) => l.id === "books");
    expect(books).toMatchObject({ direct: "deny", effective: null, inherited: [{ via: "everyone", role: "viewer" }] });
    expect(body.inbox).toMatchObject({ direct: null });
  });

  it("for a group: its members, its own grants, and the baseline beside them", async () => {
    const res = await app.inject({ method: "GET", url: "/api/access/group/petrov", headers: { cookie: await signIn("admin") } });
    const body = res.json();
    expect(body.subject).toMatchObject({ subjectType: "group", members: [{ id: "cousin" }] });
    expect(body.libraries.find((l: { id: string }) => l.id === "archive")).toMatchObject({ direct: "member", effective: null });
    expect(body.shares).toEqual([]);
  });

  it("lists what was sent to the person directly", async () => {
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('a1', 'Dacha 1985', 'admin')").run();
    db.prepare("INSERT INTO shares (id, module, resource_id, user_id, created_by) VALUES ('s1', 'gallery_album', 'a1', 'cousin', 'admin')").run();
    const res = await app.inject({ method: "GET", url: "/api/access/user/cousin", headers: { cookie: await signIn("admin") } });
    expect(res.json().shares).toMatchObject([{ id: "s1", module: "gallery_album", title: "Dacha 1985", from: "admin" }]);
  });

  it("is for admins only, and says when there is no such subject", async () => {
    const cousin = await signIn("cousin");
    expect((await app.inject({ method: "GET", url: "/api/access/user/admin", headers: { cookie: cousin } })).statusCode).toBe(403);
    const admin = await signIn("admin");
    expect((await app.inject({ method: "GET", url: "/api/access/user/nobody", headers: { cookie: admin } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/access/robot/x", headers: { cookie: admin } })).statusCode).toBe(400);
  });
});

describe("an invite that carries groups", () => {
  it("puts the new account into them as it is created; built-in groups are not joinable", async () => {
    const admin = await signIn("admin");
    const created = await app.inject({
      method: "POST", url: "/api/invites", headers: { cookie: admin },
      payload: { groupIds: ["petrov", EVERYONE_GROUP_ID, "missing"] }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().invite.groups).toEqual([{ id: "petrov", name: "petrov" }]);
    const listed = await app.inject({ method: "GET", url: "/api/invites", headers: { cookie: admin } });
    expect(listed.json().invites[0].groups).toEqual([{ id: "petrov", name: "petrov" }]);

    const token = created.json().invite.url.split("/invite/")[1];
    const accepted = await app.inject({
      method: "POST", url: `/api/invites/${token}/accept`,
      payload: { email: "michael@example.com", password: "Correct-horse-battery-9", displayName: "Michael" }
    });
    expect(accepted.statusCode).toBe(201);
    const userId = accepted.json().user.id;
    const groups = db.prepare("SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id").all(userId);
    expect(groups).toEqual([{ group_id: "petrov" }]);
    // And so he reaches what the group is given.
    const access = await app.inject({ method: "GET", url: `/api/access/user/${userId}`, headers: { cookie: admin } });
    expect(access.json().libraries.find((l: { id: string }) => l.id === "archive")).toMatchObject({ effective: "member" });
  });

  it("skips a group deleted before the invite was used", async () => {
    const admin = await signIn("admin");
    const created = await app.inject({ method: "POST", url: "/api/invites", headers: { cookie: admin }, payload: { groupIds: ["petrov"] } });
    db.prepare("DELETE FROM user_groups WHERE id = 'petrov'").run();
    const token = created.json().invite.url.split("/invite/")[1];
    const accepted = await app.inject({
      method: "POST", url: `/api/invites/${token}/accept`,
      payload: { email: "anna@example.com", password: "Correct-horse-battery-9", displayName: "Anna" }
    });
    expect(accepted.statusCode).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?").get(accepted.json().user.id)).toEqual({ n: 0 });
  });
});
