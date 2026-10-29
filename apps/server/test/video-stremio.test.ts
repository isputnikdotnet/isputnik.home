// Stremio links (modules/library/video/stremio.ts, docs/stremio-plan.md): a
// member's token in the path stands in for the session on /video/stremio/, and
// gets exactly the checks a session would. A stand-in engine echoes what home
// forwarded.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { createApiToken } from "../src/core/api-tokens.js";
import { maskLogUrl } from "../src/core/log-redaction.js";
import { getServerId } from "../src/core/server-id.js";
import { stripHopByHopHeaders } from "../src/modules/apps/gateway.js";
import { videoPlugin } from "../src/modules/library/video/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "video-gateway-secret-0123456789abcdef";

let engine: FastifyInstance;
let engineUrl: string;
let booted: BootedApp;
let engineCalls: number;

async function startEngine() {
  engineCalls = 0;
  engine = Fastify();
  engine.addHook("onRequest", async () => {
    engineCalls += 1;
  });
  engine.put("/video/api/admin/libraries/:id", async (_request, reply) => reply.code(201).send({}));
  engine.post("/video/api/admin/libraries/sync", async () => ({ detached: [], reattached: [] }));
  engine.get("/video/stremio/*", async (request) => ({ url: request.url, headers: request.headers }));
  await engine.listen({ host: "127.0.0.1", port: 0 });
  const address = engine.server.address();
  engineUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  await startEngine();
  booted = await bootApp({ plugins: [[videoPlugin, { upstream: engineUrl, secret: SECRET }]] });
});

afterEach(async () => {
  await booted.app.close();
  await engine.close();
});

const as = async (who: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  booted.app.inject({ method, url, payload: payload as never, headers: { cookie: await booted.signIn(who) } });

/** A new link for mum; the raw token is read back out of the manifest address. */
async function mumsLink(label = "Living room TV") {
  const res = await as("mum", "POST", "/api/account/stremio", { label });
  expect(res.statusCode).toBe(201);
  const { id, manifestUrl, installUrl } = res.json() as { id: string; manifestUrl: string; installUrl: string };
  const raw = /\/video\/stremio\/([^/]+)\/manifest\.json$/.exec(manifestUrl)![1];
  return { id, raw, manifestUrl, installUrl };
}

const fromTv = (url: string, remoteAddress = "192.168.1.226") => booted.app.inject({ method: "GET", url, remoteAddress });

describe("a member's Stremio link", () => {
  it("is made once, shown once, and listed without its secret", async () => {
    const link = await mumsLink();
    expect(link.raw).toMatch(/^isp_video-stremio_/);
    expect(link.installUrl).toBe(link.manifestUrl.replace(/^https?:\/\//, "stremio://"));
    const listed = (await as("mum", "GET", "/api/account/stremio")).json();
    expect(listed.enabled).toBe(true);
    expect(listed.links).toEqual([expect.objectContaining({ id: link.id, label: "Living room TV" })]);
    expect(JSON.stringify(listed)).not.toContain(link.raw);
  });

  it("reaches the engine as its owner, with the libraries they may see and this install's id", async () => {
    const library = await as("admin", "POST", "/api/library/video-libraries", { name: "Family films", kind: "movies", folder: "Films" });
    expect(library.statusCode).toBe(201);
    const libraryId = library.json().library.id as string;
    const { raw } = await mumsLink();

    const res = await fromTv(`/video/stremio/${raw}/manifest.json`);
    expect(res.statusCode).toBe(200);
    // Stremio is another origin: posters must be allowed to load there.
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    // …and its player must be allowed to read the stream and seek in it.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    const { url, headers } = res.json() as { url: string; headers: Record<string, string> };
    expect(url).toBe(`/video/stremio/${raw}/manifest.json`);
    const mum = db.prepare("SELECT id FROM users WHERE email LIKE 'mum%'").get() as { id: string };
    expect(headers).toMatchObject({
      "x-isputnik-gateway": SECRET,
      "x-isputnik-user-id": mum.id,
      "x-isputnik-via": "token",
      "x-isputnik-app-role": "member",
      "x-isputnik-network": "home",
      "x-isputnik-libraries": libraryId,
      "x-isputnik-site-id": getServerId()
    });
    expect(headers["x-isputnik-base-url"]).toMatch(new RegExp(`/video/stremio/${raw}$`));
    expect(decodeURIComponent(headers["x-isputnik-site-name"])).toMatch(/^iSputnik/);
  });

  it("drops a header the TV sent pretending to be the gateway", async () => {
    const { raw } = await mumsLink();
    const res = await booted.app.inject({
      method: "GET", url: `/video/stremio/${raw}/manifest.json`, remoteAddress: "192.168.1.226",
      headers: { "x-isputnik-libraries": "everything", "x-isputnik-site-id": "someone-else" }
    });
    expect(res.json().headers["x-isputnik-libraries"]).toBe("");
    expect(res.json().headers["x-isputnik-site-id"]).toBe(getServerId());
  });

  it("is refused once revoked, and never reaches the engine", async () => {
    const { id, raw } = await mumsLink();
    expect((await as("mum", "DELETE", `/api/account/stremio/${id}`)).statusCode).toBe(200);
    expect((await fromTv(`/video/stremio/${raw}/manifest.json`)).statusCode).toBe(401);
    expect(engineCalls).toBe(0);
  });

  it("refuses a made-up token, a missing one, and a reading app's token", async () => {
    const opds = createApiToken((db.prepare("SELECT id FROM users WHERE email LIKE 'mum%'").get() as { id: string }).id, null, "opds");
    for (const url of ["/video/stremio/isp_video-stremio_nothing/manifest.json", "/video/stremio/", `/video/stremio/${opds.raw}/manifest.json`]) {
      expect((await fromTv(url)).statusCode).toBe(401);
    }
    expect(engineCalls).toBe(0);
  });

  it("is not a way round the token: a session alone gets nowhere on these routes", async () => {
    expect((await as("mum", "GET", "/video/stremio/anything/manifest.json")).statusCode).toBe(401);
  });

  it("works only from the home network by default", async () => {
    const { raw } = await mumsLink();
    const res = await fromTv(`/video/stremio/${raw}/manifest.json`, "203.0.113.9");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ capability: "devices", rule: "home" });
  });

  it("cannot take back someone else's link", async () => {
    const { id } = await mumsLink();
    expect((await as("admin", "DELETE", `/api/account/stremio/${id}`)).statusCode).toBe(404);
  });

  it("never passes on the engine's own connection headers", () => {
    // Copied through, a player that asked to close was told keep-alive, and its
    // next request on that socket got a bare 400 (every third Stremio seek).
    expect(stripHopByHopHeaders({
      connection: "keep-alive, x-hop", "keep-alive": "timeout=72", "x-hop": "1", "content-type": "video/x-matroska", "content-range": "bytes 0-9/10"
    })).toEqual({ "content-type": "video/x-matroska", "content-range": "bytes 0-9/10" });
  });

  it("never lands in a log", () => {
    expect(maskLogUrl("/video/stremio/isp_video-stremio_SECRET/stream/movie/x.json")).toBe("/video/stremio/<token>/stream/movie/x.json");
  });
});

describe("the administrator's list", () => {
  it("shows every member's links with their owner, and revokes one", async () => {
    const { id, raw } = await mumsLink();
    const list = (await as("admin", "GET", "/api/apps/admin/video/stremio-links")).json();
    expect(list.links).toEqual([expect.objectContaining({ id, label: "Living room TV", userName: expect.any(String) })]);
    expect(JSON.stringify(list)).not.toContain(raw);
    expect((await as("admin", "DELETE", `/api/apps/admin/video/stremio-links/${id}`)).statusCode).toBe(200);
    expect((await fromTv(`/video/stremio/${raw}/manifest.json`)).statusCode).toBe(401);
  });

  it("is the administrator's only", async () => {
    expect((await as("mum", "GET", "/api/apps/admin/video/stremio-links")).statusCode).toBe(403);
  });
});
