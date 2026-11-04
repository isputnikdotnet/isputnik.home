// Films and shows in home's own lists (docs/video-home-rows-plan.md, R4):
// Collections, My list and the video page's Collection rows. The catalog is the
// engine's; home keeps what a card needs (video_refs) and answers access from
// the title's library, so none of these is a way to a library someone may not see.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { collectionsPlugin } from "../src/modules/collections/routes.js";
import { videoPlugin } from "../src/modules/library/video/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "video-gateway-secret-0123456789abcdef";

let engine: FastifyInstance;
let booted: BootedApp;
/** What the stand-in engine has, by id. */
let titles: Map<string, { libraryId: string; title: string; year: number; poster: string }>;
let open: string;
let closed: string;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  titles = new Map();
  engine = Fastify();
  engine.put("/video/api/admin/libraries/:id", async (_request, reply) => reply.code(201).send({}));
  engine.post("/video/api/admin/libraries/sync", async () => ({ detached: [], reattached: [] }));
  engine.delete("/video/api/admin/libraries/:id", async () => ({ deleted: true }));
  // As the real engine: a title only for a caller whose libraries hold it.
  const title = async (request: { params: unknown; headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const found = titles.get((request.params as { id: string }).id);
    const readable = String(request.headers["x-isputnik-libraries"] ?? "").split(",");
    return found && readable.includes(found.libraryId) ? found : reply.code(404).send({ error: "No such title" });
  };
  engine.get("/video/api/movies/:id", title);
  engine.get("/video/api/shows/:id", title);
  await engine.listen({ host: "127.0.0.1", port: 0 });
  const address = engine.server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  booted = await bootApp({ plugins: [collectionsPlugin, [videoPlugin, { upstream: url, secret: SECRET }]] });
  const create = async (payload: Record<string, unknown>) => (await as("admin", "POST", "/api/library/video-libraries", { defaultLanguage: "en", ...payload })).json().library.id as string;
  open = await create({ name: "Films", kind: "movies", folder: "Films" });
  closed = await create({ name: "Grown-ups", kind: "movies", folder: "Grown", visibility: "private" });
  // The admin is let into the private library; Mum is not.
  db.prepare("INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role) VALUES ('user', 'admin', 'library', ?, 'viewer')").run(closed);
  titles.set("m1", { libraryId: open, title: "The General", year: 1926, poster: "/video/api/art/m1/poster" });
  titles.set("m2", { libraryId: closed, title: "Night Film", year: 1968, poster: "/video/api/art/m2/poster" });
});

afterEach(async () => {
  await booted.app.close();
  await engine.close();
});

async function as(who: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  return booted.app.inject({ method, url, payload: payload as never, headers: { cookie: await booted.signIn(who) } });
}

const newCollection = async (who: string, name: string) => (await as(who, "POST", "/api/collections", { name })).json().collection.id as string;

describe("films in Collections", () => {
  it("are added with what their card needs, from the engine", async () => {
    const id = await newCollection("mum", "Sunday films");
    expect((await as("mum", "POST", `/api/collections/${id}/items`, { entityType: "video_movie", entityId: "m1" })).statusCode).toBe(200);
    const items = (await as("mum", "GET", `/api/collections/${id}`)).json().collection.items;
    expect(items).toEqual([expect.objectContaining({
      entityType: "video_movie", entityId: "m1", available: true, title: "The General", subtitle: "1926",
      coverUrl: "/video/api/art/m1/poster", href: "/movies/m1", playable: false
    })]);
  });

  it("are refused from a library the person may not see, and from nowhere", async () => {
    const id = await newCollection("mum", "Mine");
    expect((await as("mum", "POST", `/api/collections/${id}/items`, { entityType: "video_movie", entityId: "m2" })).statusCode).toBe(404);
    expect((await as("mum", "POST", `/api/collections/${id}/items`, { entityType: "video_movie", entityId: "nope" })).statusCode).toBe(404);
  });

  it("go when their library is deleted", async () => {
    const id = await newCollection("admin", "All");
    await as("admin", "POST", `/api/collections/${id}/items`, { entityType: "video_movie", entityId: "m1" });
    await as("admin", "PUT", "/api/video/my-list/movies/m1");
    expect((await as("admin", "DELETE", `/api/library/video-libraries/${open}`)).json()).toEqual({ deleted: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM collection_items").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_my_list").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_refs").get()).toEqual({ n: 0 });
  });
});

describe("My list", () => {
  it("is each person's own, newest first, and says whether a title is on it", async () => {
    titles.set("s1", { libraryId: open, title: "Harbour Lights", year: 2020, poster: "/video/api/art/s1/poster" });
    expect((await as("mum", "PUT", "/api/video/my-list/movies/m1")).json()).toEqual({ inList: true });
    await as("mum", "PUT", "/api/video/my-list/shows/s1");
    expect((await as("mum", "GET", "/api/video/my-list")).json().items.map((item: { id: string }) => item.id)).toEqual(["s1", "m1"]);
    expect((await as("mum", "GET", "/api/video/my-list/movies/m1")).json()).toEqual({ inList: true });
    expect((await as("admin", "GET", "/api/video/my-list")).json().items).toEqual([]);
    await as("mum", "DELETE", "/api/video/my-list/movies/m1");
    expect((await as("mum", "GET", "/api/video/my-list/movies/m1")).json()).toEqual({ inList: false });
  });

  it("takes nothing from a library the person may not see", async () => {
    expect((await as("mum", "PUT", "/api/video/my-list/movies/m2")).statusCode).toBe(404);
  });

  it("hides what a person can no longer see", async () => {
    await as("admin", "PUT", "/api/video/my-list/movies/m2");
    db.prepare("UPDATE video_refs SET library_id = 'gone' WHERE entity_id = 'm2'").run();
    expect((await as("admin", "GET", "/api/video/my-list")).json().items).toEqual([]);
  });
});

describe("a Collection row", () => {
  it("shows a collection's films to its owner, and to everyone once an admin puts it on their page", async () => {
    const id = await newCollection("admin", "Family movie night");
    await as("admin", "POST", `/api/collections/${id}/items`, { entityType: "video_movie", entityId: "m1" });
    await as("admin", "POST", `/api/collections/${id}/items`, { entityType: "video_movie", entityId: "m2" });
    expect((await as("admin", "GET", `/api/video/home/collections/${id}`)).json()).toEqual({
      name: "Family movie night",
      items: [
        { kind: "movies", id: "m1", title: "The General", year: 1926, poster: "/video/api/art/m1/poster" },
        { kind: "movies", id: "m2", title: "Night Film", year: 1968, poster: "/video/api/art/m2/poster" }
      ]
    });
    // Not Mum's to read until it is on everyone's page…
    expect((await as("mum", "GET", `/api/video/home/collections/${id}`)).statusCode).toBe(404);
    await as("admin", "PUT", "/api/video/home", { rows: [{ id: "c", type: "collection", collectionId: id }] });
    // …and then only the films of libraries she may see.
    expect((await as("mum", "GET", `/api/video/home/collections/${id}`)).json().items.map((item: { id: string }) => item.id)).toEqual(["m1"]);
  });

  it("is only ever of the saver's own collection", async () => {
    const theirs = await newCollection("admin", "Admin's");
    const res = await as("mum", "PUT", "/api/video/home", { rows: [{ id: "c", type: "collection", collectionId: theirs }], scope: "mine" });
    expect(res.statusCode).toBe(400);
    const mine = await newCollection("mum", "Mum's");
    expect((await as("mum", "PUT", "/api/video/home", { rows: [{ id: "c", type: "collection", collectionId: mine }, { id: "l", type: "mylist" }], scope: "mine" })).statusCode).toBe(200);
  });
});
