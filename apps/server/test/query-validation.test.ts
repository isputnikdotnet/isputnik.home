// Query strings are validated, not cast. Fastify hands a repeated key over as an
// ARRAY (`?url=a&url=b` → ["a", "b"]), and the handlers used to cast
// request.query to `{ url?: string }` and call .trim() on it — a TypeError, so an
// unexpected, error-logged 500 for what is only a malformed request. parseQuery
// (core/shared.ts) turns that into a 400. These pin that on a few representative
// routes, and pin that well-formed queries — including the junk values some
// routes quietly default — behave exactly as they did before.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../src/db.js";
import { parseQuery, queryBool, queryList } from "../src/core/shared.js";
import { registerBookRoutes } from "../src/modules/library/audiobook/books-routes.js";
import { registerMetadataRoutes } from "../src/modules/library/audiobook/metadata-routes.js";
import { registerQuoteRoutes } from "../src/modules/library/quotes.js";
import { securityRoutes } from "../src/core/security-routes.js";
import { resetDb, makeUser, grant } from "./helpers/seed.js";

let app: FastifyInstance;

async function req(method: "GET" | "POST", url: string, user = "member", body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { "x-test-user": user, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {})
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM ip_reputation").run();
  makeUser("admin", "admin");
  makeUser("member");

  // An audiobook the member can edit, and an ebook with one readable document.
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('AUD', 'AUD', 'audiobook', '/src/AUD', 'admin', '{}')"
  ).run();
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('EBK', 'EBK', 'ebook', '/src/EBK', 'admin', '{}')"
  ).run();
  grant("user", "member", "AUD", "contributor");
  grant("user", "member", "EBK", "member");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('book1', 'AUD', 'audiobook', 'book1', 'ready')").run();
  db.prepare("INSERT INTO audiobook_details (item_id, duration_seconds) VALUES ('book1', 3600)").run();
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('ebook1', 'EBK', 'ebook', 'ebook1', 'ready')").run();
  db.prepare("INSERT INTO document_files (id, item_id, relative_path, format) VALUES ('doc1', 'ebook1', 'ebook1.epub', 'epub')").run();

  app = fastify();
  const auth = async (
    request: { headers: Record<string, unknown>; user?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => void } }
  ) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "Unauthenticated" }); return; }
    request.user = row;
  };
  app.decorate("authenticate", auth);
  app.decorate("requireAdmin", auth);
  registerBookRoutes(app);
  registerMetadataRoutes(app);
  registerQuoteRoutes(app);
  await app.register(securityRoutes);
  await app.ready();
});

describe("parseQuery", () => {
  const schema = z.object({ q: z.string().optional(), limit: z.coerce.number().int().optional() });

  it("reads a missing query as an empty one", () => {
    expect(parseQuery(schema, undefined)).toEqual({ data: {} });
  });

  it("fails a repeated scalar key with the parseBody error shape", () => {
    const parsed = parseQuery(schema, { q: ["a", "b"] });
    expect(parsed.data).toBeUndefined();
    expect(parsed.error?.fieldErrors.q?.length).toBeGreaterThan(0);
  });

  it("coerces numbers and fails junk", () => {
    expect(parseQuery(schema, { limit: "12" }).data).toEqual({ limit: 12 });
    expect(parseQuery(schema, { limit: "twelve" }).error).toBeDefined();
  });

  it("maps queryBool without reading \"false\" as true", () => {
    const flags = z.object({ on: queryBool.optional() });
    expect(parseQuery(flags, { on: "true" }).data).toEqual({ on: true });
    expect(parseQuery(flags, { on: "1" }).data).toEqual({ on: true });
    expect(parseQuery(flags, { on: "false" }).data).toEqual({ on: false });
    expect(parseQuery(flags, { on: "0" }).data).toEqual({ on: false });
    expect(parseQuery(flags, { on: "yes" }).error).toBeDefined();
  });

  it("normalises a queryList to an array whether it came once or repeated", () => {
    const list = z.object({ tag: queryList.optional() });
    expect(parseQuery(list, { tag: "a" }).data).toEqual({ tag: ["a"] });
    expect(parseQuery(list, { tag: ["a", "b"] }).data).toEqual({ tag: ["a", "b"] });
    expect(parseQuery(list, {}).data).toEqual({});
  });
});

describe("a repeated scalar key is a 400, not a 500", () => {
  it("metadata-from-url (url?.trim() on an array)", async () => {
    const res = await req("GET", "/api/library/books/book1/metadata-from-url?url=https://a.example/1&url=https://b.example/2");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
    expect((res.body.details as { fieldErrors: Record<string, unknown> }).fieldErrors.url).toBeDefined();
  });

  it("reading-progress (documentId.trim() on an array)", async () => {
    const res = await req("GET", "/api/library/books/ebook1/reading-progress?documentId=doc1&documentId=doc2");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
  });

  it("the quotes list (q.trim() on an array)", async () => {
    const res = await req("GET", "/api/library/quotes?q=one&q=two");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
  });

  it("the audiobook facets (libraryId handed on as an array)", async () => {
    const res = await req("GET", "/api/library/audiobooks/facets?scope=library&libraryId=AUD&libraryId=EBK");
    expect(res.status).toBe(400);
  });

  it("a mistyped body id on reading-progress/complete (.trim() on a number)", async () => {
    const res = await req("POST", "/api/library/books/ebook1/reading-progress/complete", "member", { documentId: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Document id is required");
  });
});

describe("well-formed queries behave as before", () => {
  it("reads reading progress for a named document, and still asks for a missing one", async () => {
    const ok = await req("GET", "/api/library/books/ebook1/reading-progress?documentId=doc1");
    expect(ok.status).toBe(200);
    expect(ok.body.progress).toBeNull();

    const missing = await req("GET", "/api/library/books/ebook1/reading-progress?documentId=%20");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("Document id is required");
  });

  it("marks a document finished from a well-formed body, and a bodyless call is the missing-id 400", async () => {
    expect((await req("POST", "/api/library/books/ebook1/reading-progress/complete", "member", { documentId: "doc1" })).status).toBe(200);
    const bare = await req("POST", "/api/library/books/ebook1/reading-progress/complete");
    expect(bare.status).toBe(400);
    expect(bare.body.error).toBe("Document id is required");
  });

  it("answers the facets for one library", async () => {
    expect((await req("GET", "/api/library/audiobooks/facets?scope=library&libraryId=AUD")).status).toBe(200);
  });

  it("still asks for a link when metadata-from-url gets none", async () => {
    const res = await req("GET", "/api/library/books/book1/metadata-from-url?url=%20");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("A book link is required");
  });

  it("pages the quotes list, and junk paging still falls back to the defaults", async () => {
    const insert = db.prepare("INSERT INTO quotes (id, user_id, text) VALUES (?, 'member', ?)");
    for (let i = 0; i < 60; i += 1) insert.run(`q${i}`, `Quote number ${i}`);

    const five = await req("GET", "/api/library/quotes?limit=5");
    expect(five.status).toBe(200);
    expect(five.body.quotes).toHaveLength(5);
    expect(five.body.total).toBe(60);

    // Junk limit → the default page of 50; junk offset → the first page.
    const junk = await req("GET", "/api/library/quotes?limit=lots&offset=later");
    expect(junk.status).toBe(200);
    expect(junk.body.quotes).toHaveLength(50);

    const searched = await req("GET", "/api/library/quotes?q=number%2042");
    expect(searched.body.total).toBe(1);
  });

  it("still takes ip as a repeated key — the one list that legitimately repeats", async () => {
    const many = await req("GET", "/api/security/ip-reputation?ip=203.0.113.9&ip=198.51.100.4", "admin");
    expect(many.status).toBe(200);
    expect(many.body.reputation).toEqual([]);
    expect((await req("GET", "/api/security/ip-reputation?ip=203.0.113.9", "admin")).status).toBe(200);
    expect((await req("GET", "/api/security/ip-reputation", "admin")).status).toBe(200);
  });
});
