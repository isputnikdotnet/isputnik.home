// The family tree's online place lookup: the same proxy Review mode offers a
// photo, for the villages and parishes the offline places database will never
// hold. The network is stubbed so the suite never leaves the machine, and every
// test uses a distinct query — geocode.ts caches by query text for the life of
// the process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { familyTreeRoutesPlugin } from "../src/modules/familytree/routes.js";
import { resetDb, makeUser } from "./helpers/seed.js";

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })) as unknown as typeof fetch);
}

let app: FastifyInstance;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined
      : undefined;
    if (!row) {
      reply.code(401).send({ error: "Unauthenticated" });
      return;
    }
    request.user = row as never;
  });
  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") reply.code(403).send({ error: "Admin only" });
  });
  await app.register(familyTreeRoutesPlugin);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

const asAdmin = { headers: { "x-test-user": "admin" } };

describe("family tree online place lookup", () => {
  it("answers with the geocoder's full address and its short form", async () => {
    stubFetch(200, [{
      display_name: "Ratomka, Minsk District, Minsk Region, 223054, Belarus",
      name: "Ratomka",
      address: { village: "Ratomka", country: "Belarus" },
      lat: "53.9500",
      lon: "27.3167"
    }]);

    const res = await app.inject({ method: "GET", url: "/api/family-tree/places/online?q=Ratomka", ...asAdmin });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([{
      label: "Ratomka, Minsk District, Minsk Region, 223054, Belarus",
      short: "Ratomka, Belarus",
      lat: 53.95,
      lng: 27.3167
    }]);
  });

  it("refuses a query too thin to send anywhere, without calling out", async () => {
    stubFetch(200, []);
    const res = await app.inject({ method: "GET", url: "/api/family-tree/places/online?q=R", ...asAdmin });
    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns a failed lookup into a readable 502", async () => {
    stubFetch(500, []);
    const res = await app.inject({ method: "GET", url: "/api/family-tree/places/online?q=broken parish", ...asAdmin });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/lookup failed/i);
  });

  it("is behind the same sign-in as the rest of the tree", async () => {
    stubFetch(200, []);
    const res = await app.inject({ method: "GET", url: "/api/family-tree/places/online?q=anywhere at all" });
    expect(res.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});
