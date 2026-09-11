// The duplicate-cleanup HTTP layer (gallery/duplicates/job-routes.ts). The engine
// behind it has a dozen test files; the routes had none, and they are where three
// promises are actually kept:
//
//   * every route is admin-only — a cleanup spans libraries, so which copy survives
//     is a whole-install decision — and a linked display is no admin at all;
//   * the routes that remove or replace photos carry `config.destructive`, so the
//     "deletions only from trusted networks" policy refuses them from outside (the
//     hook lives in index.ts; it is reproduced here verbatim, reading the same
//     route config), while the paperwork around them keeps working from anywhere;
//   * a body or query that doesn't fit the schema is a 400, never a half-applied
//     change.
//
// Plus the read routes' happy path over a job with a real snapshot in it, and the
// owner/any-admin split (work vs retire) as the routes speak it.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Starting a scan nudges the fingerprint worker, which reads files in the
// background; nothing here wants it running past the end of a test.
vi.mock("../src/modules/library/gallery/duplicates/scan-queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/library/gallery/duplicates/scan-queue.js")>();
  return { ...actual, processDuplicateScanQueue: vi.fn(async () => {}) };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { registerAuthDecorators } from "../src/auth.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import {
  addTrustedNetwork, deletionBlocked, DEFAULT_SECURITY_POLICY, setSecurityPolicy
} from "../src/core/security.js";
import { galleryDuplicateJobRoutesPlugin } from "../src/modules/library/gallery/duplicates/job-routes.js";
import { runJobScan } from "../src/modules/library/gallery/duplicates/job-scan.js";
import { resetDb, makeUser, makeLibrary, grant, futureIso } from "./helpers/seed.js";

const BASE = "/api/library/gallery/duplicate-jobs";
const OUTSIDE = "8.8.8.8";
const HOME = "192.168.1.20";

let app: FastifyInstance;

function session(userId: string, kind: "browser" | "device" = "browser"): string {
  const token = `tok-${userId}-${kind}`;
  db.prepare("INSERT OR IGNORE INTO sessions (id, token_hash, user_id, expires_at, kind) VALUES (?, ?, ?, ?, ?)")
    .run(`s-${userId}-${kind}`, sha256(token), userId, futureIso(), kind);
  return `isputnik_sid=${token}`;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function call(method: Method, url: string, opts: { as?: string; device?: boolean; payload?: object; from?: string } = {}) {
  return app.inject({
    method,
    url,
    remoteAddress: opts.from ?? HOME,
    headers: opts.as ? { cookie: session(opts.as, opts.device ? "device" : "browser") } : {},
    ...(opts.payload ? { payload: opts.payload } : {})
  });
}

function asset(id: string, relativePath: string, hash: string): void {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, 'GAL', 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
    VALUES (?, 'photo', ?, 1000, ?, 'm1', 'm1')
  `).run(id, relativePath, hash);
}

/** A job owned by u1 over GAL, created through the route. */
async function createJob(duplicateType: "files" | "folders" = "files"): Promise<string> {
  const res = await call("POST", BASE, { as: "u1", payload: { libraryIds: ["GAL"], duplicateType } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { activeJob: { id: string } }).activeJob.id;
}

beforeEach(async () => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "admin");
  makeUser("m1", "member");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");

  app = Fastify();
  await app.register(cookie);
  // index.ts's deletion-protection hook, as written there.
  app.addHook("onRequest", async (request, reply) => {
    if (deletionBlocked(request, request.routeOptions?.config)) {
      await reply.code(403).send({ error: "Deleting is disabled outside trusted networks." });
    }
  });
  await registerAuthDecorators(app);
  await app.register(galleryDuplicateJobRoutesPlugin);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// Every route the plugin serves, with placeholder ids — the guards answer before
// any id is looked up.
const ROUTES: [Method, string][] = [
  ["GET", BASE],
  ["GET", `${BASE}/folder-options?libraryIds=GAL`],
  ["GET", `${BASE}/j1`],
  ["POST", BASE],
  ["PATCH", `${BASE}/j1`],
  ["POST", `${BASE}/j1/preferences`],
  ["POST", `${BASE}/j1/scan`],
  ["GET", `${BASE}/j1/results`],
  ["POST", `${BASE}/j1/results/sweep`],
  ["POST", `${BASE}/j1/results/r1/mark`],
  ["POST", `${BASE}/j1/results/r1/members/m1/role`],
  ["POST", `${BASE}/j1/results/r1/dismiss`],
  ["GET", `${BASE}/j1/results/r1/check`],
  ["POST", `${BASE}/j1/results/r1/replace`],
  ["POST", `${BASE}/j1/results/replace-larger`],
  ["POST", `${BASE}/j1/results/r1/resolve`],
  ["POST", `${BASE}/j1/apply-preferences`],
  ["POST", `${BASE}/j1/complete`],
  ["POST", `${BASE}/j1/cancel`],
  ["POST", `${BASE}/j1/reassign`],
  ["DELETE", `${BASE}/j1`]
];

describe("who may call them", () => {
  it("lists every route the plugin registers", () => {
    // If a route is added, it belongs in ROUTES (and so under the guards below).
    const registered = app.printRoutes({ commonPrefix: false })
      .split("\n").filter((line) => /\(([A-Z, ]+)\)/.test(line));
    const count = registered.reduce((sum, line) => {
      const methods = line.match(/\(([A-Z, ]+)\)/)![1].split(",").map((m) => m.trim()).filter((m) => m !== "HEAD");
      return sum + methods.length;
    }, 0);
    expect(count).toBe(ROUTES.length);
  });

  it.each(ROUTES)("%s %s: 401 without a session", async (method, url) => {
    const res = await call(method, url, { payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES)("%s %s: 403 for a member", async (method, url) => {
    const res = await call(method, url, { as: "m1", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Admin access required");
  });

  it.each(ROUTES)("%s %s: 403 for an admin's linked display", async (method, url) => {
    const res = await call(method, url, { as: "u1", device: true, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/This device can't use admin features/);
  });
});

describe("deletion protection", () => {
  const DESTRUCTIVE: [Method, string][] = [
    ["POST", `${BASE}/j1/results/sweep`],
    ["POST", `${BASE}/j1/results/r1/replace`],
    ["POST", `${BASE}/j1/results/replace-larger`],
    ["POST", `${BASE}/j1/results/r1/resolve`],
    // A DELETE is destructive by definition, even of the job's own paperwork.
    ["DELETE", `${BASE}/j1`]
  ];
  const enable = () => {
    setSecurityPolicy({ ...DEFAULT_SECURITY_POLICY, trustedDeletesOnly: true }, null);
    addTrustedNetwork("192.168.0.0/16", "Home", null);
  };

  it.each(DESTRUCTIVE)("%s %s is refused from outside a trusted network", async (method, url) => {
    enable();
    const res = await call(method, url, { as: "u1", from: OUTSIDE, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Deleting is disabled outside trusted networks.");
  });

  it.each(DESTRUCTIVE)("%s %s passes the guard from home", async (method, url) => {
    enable();
    const res = await call(method, url, { as: "u1", from: HOME, payload: { memberId: "m1" } });
    expect(res.json().error).not.toBe("Deleting is disabled outside trusted networks.");
  });

  it.each(DESTRUCTIVE)("%s %s passes the guard while the policy is off", async (method, url) => {
    const res = await call(method, url, { as: "u1", from: OUTSIDE, payload: { memberId: "m1" } });
    expect(res.json().error).not.toBe("Deleting is disabled outside trusted networks.");
  });

  it("leaves the paperwork alone: review and retire work from anywhere", async () => {
    enable();
    const jobId = await createJob();
    for (const [method, url, payload] of [
      ["POST", `${BASE}/${jobId}/results/r1/mark`, { mark: "reviewed" }],
      ["POST", `${BASE}/${jobId}/results/r1/dismiss`, {}],
      ["PATCH", `${BASE}/${jobId}`, { mediaType: "photo" }],
      ["POST", `${BASE}/${jobId}/cancel`, {}]
    ] as [Method, string, object][]) {
      const res = await call(method, url, { as: "u1", from: OUTSIDE, payload });
      expect(res.json().error ?? null, `${method} ${url}`).not.toBe("Deleting is disabled outside trusted networks.");
    }
  });
});

describe("what a request must look like", () => {
  it.each([
    ["no libraries", { libraryIds: [] }],
    ["no library list at all", { duplicateType: "files" }],
    ["an unknown comparison", { libraryIds: ["GAL"], duplicateType: "everything" }],
    ["a step the wizard doesn't have", { libraryIds: ["GAL"], currentStep: 9 }],
    ["a library id that is far too long", { libraryIds: ["x".repeat(65)] }]
  ])("refuses a new job with %s", async (_case, payload) => {
    const res = await call("POST", BASE, { as: "u1", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request");
    expect(db.prepare("SELECT COUNT(*) AS n FROM duplicate_jobs").get()).toEqual({ n: 0 });
  });

  it("refuses bodies and queries that don't fit, without touching the job", async () => {
    const jobId = await createJob();
    const before = db.prepare("SELECT * FROM duplicate_jobs WHERE id = ?").get(jobId);
    const cases: [Method, string, object | undefined][] = [
      ["PATCH", `${BASE}/${jobId}`, { mediaType: "holograms" }],
      ["POST", `${BASE}/${jobId}/preferences`, { folders: [{ libraryId: "GAL", folderPath: "a", mode: "maybe" }] }],
      ["POST", `${BASE}/${jobId}/preferences`, {}],
      ["POST", `${BASE}/${jobId}/results/r1/mark`, { mark: "banana" }],
      ["POST", `${BASE}/${jobId}/results/r1/members/m1/role`, { role: "maybe" }],
      ["POST", `${BASE}/${jobId}/results/r1/replace`, {}],
      ["POST", `${BASE}/${jobId}/cancel`, { reason: "x".repeat(501) }],
      ["POST", `${BASE}/${jobId}/reassign`, {}],
      ["GET", `${BASE}/${jobId}/results?perPage=500`, undefined],
      ["GET", `${BASE}/${jobId}/results?type=bogus`, undefined],
      ["POST", `${BASE}/${jobId}/results/sweep?tier=bogus`, {}],
      ["POST", `${BASE}/${jobId}/results/replace-larger?review=bogus`, {}]
    ];
    for (const [method, url, payload] of cases) {
      const res = await call(method, url, { as: "u1", payload });
      expect(res.statusCode, `${method} ${url}`).toBe(400);
    }
    expect(db.prepare("SELECT * FROM duplicate_jobs WHERE id = ?").get(jobId)).toEqual(before);
  });

  it("answers 404 for a job that doesn't exist", async () => {
    for (const [method, url, payload] of [
      ["GET", `${BASE}/nope`, undefined],
      ["GET", `${BASE}/nope/results`, undefined],
      ["GET", `${BASE}/nope/results/r1/check`, undefined],
      ["PATCH", `${BASE}/nope`, { mediaType: "photo" }],
      ["POST", `${BASE}/nope/complete`, {}],
      ["DELETE", `${BASE}/nope`, undefined]
    ] as [Method, string, object | undefined][]) {
      const res = await call(method, url, { as: "u1", payload });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe("a job with a snapshot in it", () => {
  let jobId: string;

  beforeEach(async () => {
    // Two byte-identical copies in different folders: one photo set.
    asset("p1", "2019/beach.jpg", "same-bytes");
    asset("p2", "backup/beach.jpg", "same-bytes");
    asset("p3", "2019/other.jpg", "unique");
    jobId = await createJob("files");
    const scanned = runJobScan(jobId, "u1");
    expect(scanned.ok).toBe(true);
  });

  it("serves the page payload, telling the owner from another admin", async () => {
    const mine = (await call("GET", BASE, { as: "u1" })).json();
    const theirs = (await call("GET", BASE, { as: "u2" })).json();

    expect(mine.activeJob.id).toBe(jobId);
    expect(mine.isOwner).toBe(true);
    expect(theirs.isOwner).toBe(false);
    expect(mine.libraries.map((library: { id: string }) => library.id).sort()).toEqual(["GAL", "GAL2"]);
    expect(Array.isArray(mine.history)).toBe(true);
  });

  it("serves one job, and the folder vocabulary for the wizard", async () => {
    const one = await call("GET", `${BASE}/${jobId}`, { as: "u2" });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ job: { id: jobId }, isOwner: false });

    const folders = (await call("GET", `${BASE}/folder-options?libraryIds=GAL`, { as: "u1" })).json();
    expect(folders.folders.length).toBeGreaterThan(0);
    // No libraries named is an empty list, not an error.
    expect((await call("GET", `${BASE}/folder-options`, { as: "u1" })).json()).toEqual({ folders: [] });
  });

  it("pages the results, and clamps a page past the end", async () => {
    const res = await call("GET", `${BASE}/${jobId}/results?perPage=10&page=99`, { as: "u1" });

    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page).toMatchObject({ total: 1, allResults: 1, page: 1, perPage: 10, isOwner: true });
    expect(page.results[0].members.map((member: { itemId: string }) => member.itemId).sort()).toEqual(["p1", "p2"]);
    expect(page.sweep).toBeDefined();

    const filtered = (await call("GET", `${BASE}/${jobId}/results?q=nothing-matches-this`, { as: "u1" })).json();
    expect(filtered).toMatchObject({ total: 0, allResults: 1, results: [] });
  });

  it("checks a result against the library as it stands", async () => {
    const resultId = (await call("GET", `${BASE}/${jobId}/results`, { as: "u1" })).json().results[0].id;

    const res = await call("GET", `${BASE}/${jobId}/results/${resultId}/check`, { as: "u2" });

    expect(res.statusCode).toBe(200);
    expect((await call("GET", `${BASE}/${jobId}/results/not-a-result/check`, { as: "u1" })).statusCode).toBe(404);
  });

  it("lets the owner mark a result, and nobody else", async () => {
    const resultId = (await call("GET", `${BASE}/${jobId}/results`, { as: "u1" })).json().results[0].id;

    const other = await call("POST", `${BASE}/${jobId}/results/${resultId}/mark`, { as: "u2", payload: { mark: "reviewed" } });
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe("This cleanup belongs to someone else.");

    const owner = await call("POST", `${BASE}/${jobId}/results/${resultId}/mark`, { as: "u1", payload: { mark: "reviewed" } });
    expect(owner.statusCode).toBe(200);
    const page = (await call("GET", `${BASE}/${jobId}/results?review=reviewed`, { as: "u1" })).json();
    expect(page.total).toBe(1);
  });

  it("refuses a second cleanup while this one is open", async () => {
    const res = await call("POST", BASE, { as: "u2", payload: { libraryIds: ["GAL2"] } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already in progress/);
  });

  it("refuses to change the scope once the scan has run", async () => {
    const res = await call("PATCH", `${BASE}/${jobId}`, { as: "u1", payload: { libraryIds: ["GAL", "GAL2"] } });

    expect(res.statusCode).toBe(409);
  });

  it("lets any admin hand it over or retire it", async () => {
    const handed = await call("POST", `${BASE}/${jobId}/reassign`, { as: "u2", payload: { userId: "u2" } });
    expect(handed.statusCode).toBe(200);
    expect(handed.json().isOwner).toBe(true);

    const cancelled = await call("POST", `${BASE}/${jobId}/cancel`, { as: "u1", payload: { reason: "starting over" } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().activeJob).toBeNull();

    const deleted = await call("DELETE", `${BASE}/${jobId}`, { as: "u1" });
    expect(deleted.statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM duplicate_jobs").get()).toEqual({ n: 0 });
  });

  it("logs what was done, by whom", async () => {
    await call("POST", `${BASE}/${jobId}/complete`, { as: "u2", payload: {} });

    const events = db.prepare("SELECT event, actor_user_id FROM activity_logs WHERE event LIKE 'library.gallery.duplicate_job_%' ORDER BY rowid")
      .all();
    expect(events).toEqual([
      { event: "library.gallery.duplicate_job_created", actor_user_id: "u1" },
      { event: "library.gallery.duplicate_job_completed", actor_user_id: "u2" }
    ]);
  });
});
