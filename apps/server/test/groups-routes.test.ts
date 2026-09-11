// The routes that write user groups (modules/users/groups.ts). Groups feed every
// permission check — a grant to a group reaches all of its members through
// core/permissions.ts, which has its own tests — but the rows those checks read
// are written here, and nothing covered it: admin-only throughout; a name unique
// regardless of case; membership only for live accounts; and deleting a group
// takes its members AND every grant made to it (assignments carry no FK, so this
// route is the only thing that clears them), while a group that still owns a
// library can't be deleted at all.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { groupsPlugin } from "../src/modules/users/groups.js";
import { bootApp } from "./helpers/boot.js";
import { resetDb, makeUser, makeGroup, addToGroup, grant, makeLibrary, futureIso } from "./helpers/seed.js";

let app: FastifyInstance;

function as(userId: string): { cookie: string } {
  const token = `tok-${userId}`;
  db.prepare("INSERT OR IGNORE INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)")
    .run(`s-${userId}`, sha256(token), userId, futureIso());
  return { cookie: `isputnik_sid=${token}` };
}

const groupCount = () => (db.prepare("SELECT COUNT(*) AS n FROM user_groups").get() as { n: number }).n;
const events = (event: string) =>
  db.prepare("SELECT actor_user_id, target_id FROM activity_logs WHERE event = ?").all(event) as
    { actor_user_id: string; target_id: string }[];

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("anna");
  makeUser("boris");

  ({ app } = await bootApp({ plugins: [groupsPlugin] }));
});

afterEach(async () => {
  await app.close();
});

describe("who may manage groups", () => {
  const ROUTES: ["GET" | "POST" | "DELETE", string][] = [
    ["GET", "/api/groups"],
    ["POST", "/api/groups"],
    ["DELETE", "/api/groups/g1"],
    ["GET", "/api/groups/g1/members"],
    ["POST", "/api/groups/g1/members"],
    ["DELETE", "/api/groups/g1/members/anna"]
  ];

  it.each(ROUTES)("%s %s: 401 signed out, 403 for a member", async (method, url) => {
    makeGroup("g1", "admin");
    addToGroup("g1", "anna");

    const signedOut = await app.inject({ method, url, payload: { name: "Cousins", userId: "boris" } });
    const member = await app.inject({ method, url, headers: as("anna"), payload: { name: "Cousins", userId: "boris" } });

    expect(signedOut.statusCode).toBe(401);
    expect(member.statusCode).toBe(403);
    // And the member's attempt changed nothing.
    expect(groupCount()).toBe(1);
    expect(db.prepare("SELECT user_id FROM group_members WHERE group_id = 'g1'").all()).toEqual([{ user_id: "anna" }]);
  });
});

describe("creating a group", () => {
  const create = (name: unknown) => app.inject({ method: "POST", url: "/api/groups", headers: as("admin"), payload: { name } });

  it("creates it, trimmed, and logs who did", async () => {
    const res = await create("  Cousins  ");

    expect(res.statusCode).toBe(201);
    const { group } = res.json() as { group: { id: string; name: string; memberCount: number } };
    expect(group).toMatchObject({ name: "Cousins", memberCount: 0 });
    expect(db.prepare("SELECT name, created_by FROM user_groups WHERE id = ?").get(group.id))
      .toEqual({ name: "Cousins", created_by: "admin" });
    expect(events("groups.created")).toEqual([{ actor_user_id: "admin", target_id: group.id }]);
  });

  it("refuses a second group with the same name in another case", async () => {
    await create("Cousins");

    const res = await create("cOUSINS");

    expect(res.statusCode).toBe(409);
    expect(groupCount()).toBe(1);
  });

  it.each([["x"], [""], ["   "], ["y".repeat(81)], [42]])("refuses the name %j", async (name) => {
    const res = await create(name);

    expect(res.statusCode).toBe(400);
    expect(groupCount()).toBe(0);
  });
});

describe("listing groups", () => {
  it("counts members and the libraries a group owns", async () => {
    makeGroup("g1", "admin");
    makeGroup("g2", "admin");
    addToGroup("g1", "anna");
    addToGroup("g1", "boris");
    makeLibrary("lib", { createdBy: "admin", ownerId: "g1", ownerType: "group" });

    const res = await app.inject({ method: "GET", url: "/api/groups", headers: as("admin") });

    expect(res.json().groups.map((g: { id: string; memberCount: number; libraryCount: number }) =>
      [g.id, g.memberCount, g.libraryCount])).toEqual([["g1", 2, 1], ["g2", 0, 0]]);
  });
});

describe("membership", () => {
  const add = (userId: unknown, group = "g1") =>
    app.inject({ method: "POST", url: `/api/groups/${group}/members`, headers: as("admin"), payload: { userId } });

  beforeEach(() => {
    makeGroup("g1", "admin");
  });

  it("adds a live account once, and lists it", async () => {
    expect((await add("anna")).statusCode).toBe(201);
    expect((await add("anna")).statusCode).toBe(409);

    const res = await app.inject({ method: "GET", url: "/api/groups/g1/members", headers: as("admin") });
    expect(res.json()).toMatchObject({ group: { id: "g1" }, members: [{ userId: "anna", email: "anna@test.local" }] });
  });

  it("won't add an account that is deactivated, deleted or doesn't exist", async () => {
    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'anna'").run();
    db.prepare("UPDATE users SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'boris'").run();

    expect((await add("anna")).statusCode).toBe(404);
    expect((await add("boris")).statusCode).toBe(404);
    expect((await add("nobody")).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM group_members").get()).toEqual({ n: 0 });
  });

  it("answers 404 for a group that doesn't exist, and 400 for no user", async () => {
    expect((await add("anna", "no-such-group")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/groups/no-such-group/members", headers: as("admin") })).statusCode).toBe(404);
    expect((await add("")).statusCode).toBe(400);
    expect((await add(undefined)).statusCode).toBe(400);
  });

  it("removes a member, once", async () => {
    addToGroup("g1", "anna");
    const remove = () => app.inject({ method: "DELETE", url: "/api/groups/g1/members/anna", headers: as("admin") });

    expect((await remove()).statusCode).toBe(200);
    expect((await remove()).statusCode).toBe(404);
  });
});

describe("deleting a group", () => {
  const remove = (id: string) => app.inject({ method: "DELETE", url: `/api/groups/${id}`, headers: as("admin") });

  it("takes its members and every grant made to it, and leaves everyone else's", async () => {
    makeGroup("g1", "admin");
    addToGroup("g1", "anna");
    makeLibrary("lib", { createdBy: "admin" });
    grant("group", "g1", "lib", "contributor");
    grant("group", "g1", "tree-1", "viewer", "family_tree");
    grant("group", "g1", "sc-1", "member", "story_collection");
    grant("user", "anna", "lib", "viewer");
    grant("group", EVERYONE_GROUP_ID, "lib", "member");

    const res = await remove("g1");

    expect(res.statusCode).toBe(200);
    expect(groupCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM group_members").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT subject_type, subject_id FROM assignments ORDER BY subject_id").all()).toEqual([
      { subject_type: "user", subject_id: "anna" },
      { subject_type: "group", subject_id: EVERYONE_GROUP_ID }
    ]);
    expect(events("groups.deleted")).toEqual([{ actor_user_id: "admin", target_id: "g1" }]);
  });

  it("refuses while the group owns a library, and changes nothing", async () => {
    makeGroup("g1", "admin");
    addToGroup("g1", "anna");
    makeLibrary("lib", { createdBy: "admin", ownerId: "g1", ownerType: "group" });
    grant("group", "g1", "lib", "manager");

    const res = await remove("g1");

    expect(res.statusCode).toBe(409);
    expect(groupCount()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM group_members").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments").get()).toEqual({ n: 1 });
  });

  it("can't delete Everyone, which is not a row to delete", async () => {
    // Everyone is implicit (core/permissions.ts adds it to every user's groups);
    // its grants must survive any attempt at it.
    makeLibrary("lib", { createdBy: "admin" });
    grant("group", EVERYONE_GROUP_ID, "lib", "member");

    expect((await remove(EVERYONE_GROUP_ID)).statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments").get()).toEqual({ n: 1 });
  });

  it("answers 404 for a group that doesn't exist", async () => {
    expect((await remove("nope")).statusCode).toBe(404);
  });
});
