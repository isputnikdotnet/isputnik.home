// "Email me when it's ready" for a film being prepared for download
// (modules/library/video/copy-notices.ts): one email per request, once the
// engine has made every copy of it — the engine never calls out, so this server
// looks in on it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const mail = vi.hoisted(() => ({ configured: true, sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return {
    ...actual,
    isMailConfigured: () => mail.configured,
    sendMail: async (message: { to: string; subject: string; text: string }) => { mail.sent.push(message); }
  };
});

const { db } = await import("../src/db.js");
const { videoPlugin } = await import("../src/modules/library/video/index.js");
const { settleCopyNotices } = await import("../src/modules/library/video/copy-notices.js");
const { engineClient } = await import("../src/modules/library/video/engine.js");
const { bootApp } = await import("./helpers/boot.js");
const { makeUser, resetDb } = await import("./helpers/seed.js");
type BootedApp = Awaited<ReturnType<typeof bootApp>>;

const SECRET = "video-gateway-secret-0123456789abcdef";

let engine: FastifyInstance;
let booted: BootedApp;
let url: string;
/** What the stand-in engine has made, as its admin list says. */
let copies: { itemId: string; quality: number; state: string }[];

const client = () => engineClient(() => ({ upstream: url, secret: SECRET }));
const quiet = { warn: () => undefined };
const settle = () => settleCopyNotices(client(), quiet);

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  mail.configured = true;
  mail.sent.length = 0;
  copies = [];
  engine = Fastify();
  engine.post("/video/api/admin/libraries/sync", async () => ({ detached: [], reattached: [] }));
  engine.get("/video/api/admin/copies", async () => ({ copies }));
  await engine.listen({ host: "127.0.0.1", port: 0 });
  const address = engine.server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  booted = await bootApp({ plugins: [[videoPlugin, { upstream: url, secret: SECRET }]] });
});

afterEach(async () => {
  await booted.app.close();
  await engine.close();
});

async function as(who: string, method: "GET" | "POST", path: string, payload?: unknown) {
  return booted.app.inject({ method, url: path, payload: payload as never, headers: { cookie: await booted.signIn(who) } });
}

const season = {
  batch: "batch-0001",
  items: [
    { id: "e1", quality: 720, title: "Counterpart · The Crossing" },
    { id: "e2", quality: 720, title: "Counterpart · Birds of a Feather" }
  ]
};

describe("asking to be told", () => {
  it("is offered to someone with an address on a server that sends email, and to nobody otherwise", async () => {
    expect((await as("mum", "GET", "/api/video/copy-notices")).json()).toEqual({ available: true });
    mail.configured = false;
    expect((await as("mum", "GET", "/api/video/copy-notices")).json()).toEqual({ available: false });
    expect((await as("mum", "POST", "/api/video/copy-notices", season)).statusCode).toBe(409);
  });

  it("refuses a request that names no titles or a quality that is none", async () => {
    expect((await as("mum", "POST", "/api/video/copy-notices", { batch: "batch-0001", items: [] })).statusCode).toBe(400);
    expect((await as("mum", "POST", "/api/video/copy-notices", { batch: "batch-0001", items: [{ id: "e1", quality: 999, title: "x" }] })).statusCode).toBe(400);
  });
});

describe("telling them", () => {
  it("sends one email for the whole request, once every copy of it is ready", async () => {
    expect((await as("mum", "POST", "/api/video/copy-notices", season)).statusCode).toBe(204);
    // One ready, one still being made: nothing yet.
    copies = [{ itemId: "e1", quality: 720, state: "ready" }, { itemId: "e2", quality: 720, state: "running" }];
    await settle();
    expect(mail.sent).toHaveLength(0);

    copies[1].state = "ready";
    await settle();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("mum@test.local");
    expect(mail.sent[0].subject).toBe("2 videos are ready to download");
    expect(mail.sent[0].text).toContain("Counterpart · The Crossing");
    expect(mail.sent[0].text).toContain("Counterpart · Birds of a Feather");
    expect(mail.sent[0].text).toContain("/downloads");
    // Told once: nothing is left to tell.
    await settle();
    expect(mail.sent).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_copy_notices").get()).toEqual({ n: 0 });
  });

  it("names the one film in the subject, and says when some could not be prepared", async () => {
    await as("mum", "POST", "/api/video/copy-notices", season);
    copies = [{ itemId: "e1", quality: 720, state: "ready" }, { itemId: "e2", quality: 720, state: "failed" }];
    await settle();
    expect(mail.sent[0].subject).toBe("Ready to download: Counterpart · The Crossing");
    expect(mail.sent[0].text).toContain("1 could not be prepared");
  });

  it("does not hold the email back for a title that needed no copy", async () => {
    await as("mum", "POST", "/api/video/copy-notices", season);
    copies = [{ itemId: "e1", quality: 720, state: "ready" }];
    await settle();
    expect(mail.sent).toHaveLength(0);
    // A quarter of an hour on, the engine has still made none of it: it never will.
    db.prepare("UPDATE video_copy_notices SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes')").run();
    await settle();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).not.toContain("could not be prepared");
  });

  it("keeps waiting while the engine does not answer, and gives up after two days", async () => {
    await as("mum", "POST", "/api/video/copy-notices", season);
    await engine.close();
    await settle();
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_copy_notices").get()).toEqual({ n: 2 });
    db.prepare("UPDATE video_copy_notices SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days')").run();
    await settle();
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_copy_notices").get()).toEqual({ n: 0 });
    expect(mail.sent).toHaveLength(0);
    // afterEach closes it again.
    engine = Fastify();
    await engine.listen({ host: "127.0.0.1", port: 0 });
  });
});
