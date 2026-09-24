// Who an account is in the family tree (docs/people-sharing-plan.md, D12): the
// chart knows "You", their own record is never hidden from them as a living
// relative, and the link grants nothing else.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createFamilyPerson } from "../src/modules/familytree/persons.js";
import { familyTreeRoutesPlugin } from "../src/modules/familytree/routes.js";
import { accessRoutesPlugin } from "../src/modules/users/access-routes.js";
import { deleteAccessSettingsForSubject } from "../src/modules/library/gallery/people-access.js";
import { myTreePersonId } from "../src/modules/familytree/tree-access.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;
let ids: { sam: string; child: string };

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("sam", "member");
  makeUser("anna", "member");
  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('sam-face', 'Sam')").run();
  const sam = createFamilyPerson({ name: "Sam Posse", birthDate: "1990-02-03", birthplace: "Minsk" }, "admin");
  db.prepare("UPDATE family_tree_persons SET gallery_person_id = 'sam-face' WHERE id = ?").run(sam.id);
  const child = createFamilyPerson({ name: "Child", birthDate: "2015-03-04", birthplace: "Oslo" }, "admin");
  ids = { sam: sam.id, child: child.id };
  // The household as added later: living details private.
  db.prepare("INSERT INTO access_settings (subject_type, subject_id, show_living_details) VALUES ('user', 'sam', 0)").run();
  ({ app, signIn } = await bootApp({ plugins: [familyTreeRoutesPlugin, accessRoutesPlugin] }));
});

afterEach(async () => { await app.close(); });

const link = async (userId: string, personId: string | null, as = "admin") =>
  app.inject({ method: "PUT", url: `/api/family-tree/users/${userId}/person`, headers: { cookie: await signIn(as) }, payload: { personId } });
const treeOf = async (userId: string) => (await app.inject({ method: "GET", url: "/api/family-tree/tree", headers: { cookie: await signIn(userId) } })).json();
const personIn = (tree: { persons: { id: string }[] }, id: string) => tree.persons.find((p) => p.id === id) as Record<string, unknown>;

describe("linking an account to its family-tree person", () => {
  it("marks them as You and shows them their own details, nobody else's", async () => {
    expect(personIn(await treeOf("sam"), ids.sam)).toMatchObject({ restricted: true, birthDate: null });

    expect((await link("sam", ids.sam)).json()).toMatchObject({ me: { personId: ids.sam, name: "Sam Posse", galleryPersonId: "sam-face" } });
    const tree = await treeOf("sam");
    expect(tree.access.meId).toBe(ids.sam);
    expect(personIn(tree, ids.sam)).toMatchObject({ isMe: true, restricted: false, birthDate: "1990-02-03", birthplace: "Minsk" });
    // Linking grants nothing else: other living relatives stay private.
    expect(personIn(tree, ids.child)).toMatchObject({ isMe: false, restricted: true, birthDate: null });
    // Their Access dialog knows it too.
    const overview = (await app.inject({ method: "GET", url: "/api/access/user/sam", headers: { cookie: await signIn("admin") } })).json();
    expect(overview.tree.me).toMatchObject({ personId: ids.sam, galleryPersonId: "sam-face" });

    await link("sam", null);
    expect((await treeOf("sam")).access.meId).toBeNull();
  });

  it("is one person per account, set by an admin, and goes with the account", async () => {
    await link("sam", ids.sam);
    expect((await link("anna", ids.sam)).statusCode).toBe(409);
    expect((await link("anna", "nobody")).statusCode).toBe(404);
    expect((await link("anna", ids.child, "anna")).statusCode).toBe(403);
    deleteAccessSettingsForSubject("user", "sam");
    expect(myTreePersonId("sam")).toBeNull();
  });
});
