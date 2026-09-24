// Who may curate the (global) gallery people: someone who writes in a photo
// library. Writing in the Photo Inbox — a relative reviewing it — is not enough to
// rename, delete or merge people, though it still lets them name people on the
// Inbox photos they can write.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { galleryPeopleRoutesPlugin } from "../src/modules/library/gallery/people-routes.js";
import { bootApp } from "./helpers/boot.js";
import { grant, grantReviewer, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("reviewer", "member");
  makeUser("writer", "member");
  makeLibrary("photos", { createdBy: "admin", type: "gallery" });
  makeLibrary("inbox", { createdBy: "admin", type: "gallery", policyJson: JSON.stringify({ mode: "managed" }), role: "inbox" });
  // A reviewer who may add what they know: write on the Inbox photos, nothing else.
  grantReviewer("user", "reviewer", "details");
  grant("user", "writer", "photos", "contributor");
  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('ivan', 'Ivan'), ('olga', 'Olga')").run();
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('arrived', 'inbox', 'gallery', 'arrived.jpg', 'ready')").run();
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES ('arrived', 'photo', 'arrived.jpg', 1)").run();
  ({ app, signIn } = await bootApp({ plugins: [galleryPeopleRoutesPlugin] }));
});

afterEach(async () => { await app.close(); });

const as = async (user: string, method: "PATCH" | "DELETE" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: await signIn(user) }, payload });

describe("curating gallery people", () => {
  it("is refused to someone who only writes in the Photo Inbox", async () => {
    expect((await as("reviewer", "PATCH", "/api/library/gallery/people/ivan", { name: "Not Ivan" })).statusCode).toBe(403);
    expect((await as("reviewer", "DELETE", "/api/library/gallery/people/ivan")).statusCode).toBe(403);
    expect((await as("reviewer", "POST", "/api/library/gallery/people/ivan/merge", { intoId: "olga" })).statusCode).toBe(403);
    expect((await as("reviewer", "POST", "/api/library/gallery/people", { name: "Stranger" })).statusCode).toBe(403);
    expect(db.prepare("SELECT name FROM gallery_people WHERE id = 'ivan'").get()).toEqual({ name: "Ivan" });
  });

  it("still lets them name people on an Inbox photo they can write", async () => {
    const res = await as("reviewer", "POST", "/api/library/gallery/assets/arrived/people", { personId: "ivan" });
    expect(res.statusCode).toBeLessThan(300);
  });

  it("is allowed to someone who writes in a photo library", async () => {
    expect((await as("writer", "PATCH", "/api/library/gallery/people/ivan", { name: "Ivan P." })).statusCode).toBe(200);
  });
});
