// Control panel › Infrastructure › Diagnostics (modules/diagnostics): the report an
// admin attaches to a bug report, and what it hides unless they ask to include it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { diagnosticsPlugin } from "../src/modules/diagnostics/index.js";
import { makeRedactor } from "../src/modules/diagnostics/redact.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "video-secret-for-tests-0123456789abcdef";

describe("what a report hides", () => {
  const redact = makeRedactor({
    people: ["Sergey Example", "sergey@example.org", "Mum"],
    names: ["Kids' films"],
    paths: ["/mnt/user/media/video/Kids", "Movies"]
  });

  it("replaces the household's names, folders and addresses", () => {
    expect(redact("Sergey Example scanned Kids' films at /mnt/user/media/video/Kids/Frozen (2013)/Frozen.mkv"))
      .toBe("<person> scanned <name> at <path>");
    // A folder named relative to a media root, spaces and all.
    expect(redact("Movies/Frozen (2013)/Frozen.mkv: no sound")).toBe("<path>: no sound");
    expect(redact("mail to someone@else.net from 192.168.2.10 and 203.0.113.7, see http://tower.local:8080/video"))
      .toBe("mail to <email> from <lan-ip> and <ip>, see http://<host>/video");
    expect(redact("Error opening input: /media/Films/Some Film (2010)/film.mkv: No such file"))
      .toBe("Error opening input: <path>: No such file");
    expect(redact("D:\\Video\\Mum\\holiday.mp4 failed")).toBe("<path> failed");
  });

  it("leaves words that only contain a name, clocks, versions and the app's own addresses alone", () => {
    expect(redact("Mumbai at 12:30:05, ffmpeg 7.1.1, GET /video/api/hls/abc/t1/3.ts from 127.0.0.1"))
      .toBe("Mumbai at 12:30:05, ffmpeg 7.1.1, GET /video/api/hls/abc/t1/3.ts from <lan-ip>");
    // A bare library folder only where it stands alone, and as it is written.
    expect(redact("library Movies scanned; MoviesExtra too, kind: movies")).toBe("library <name> scanned; MoviesExtra too, kind: movies");
    // A known folder with a space in its last part is hidden whole.
    const spaced = makeRedactor({ people: [], names: [], paths: ["D:/Media/App files"] });
    expect(spaced("gallery at D:/Media/App files; idle")).toBe("gallery at <path>; idle");
  });
});

describe("GET /api/admin/diagnostics", () => {
  let engine: FastifyInstance;
  let engineUrl: string;
  let booted: BootedApp | null = null;

  beforeEach(async () => {
    resetDb();
    makeUser("admin", "admin");
    makeUser("mum", "member");
    db.prepare("UPDATE users SET display_name = 'Galina Petrova', email = 'galina@home.example' WHERE id = 'mum'").run();
    makeLibrary("lib1", { createdBy: "admin", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Galina photos', source_path = '/mnt/user/photos/galina' WHERE id = 'lib1'").run();
    db.prepare("INSERT INTO activity_logs (id, event, detail) VALUES ('a1', 'library.scan.failed', 'Galina photos: /mnt/user/photos/galina is not there')").run();

    // A stand-in video engine with diagnostics of its own.
    engine = Fastify();
    engine.get("/video/api/health", async () => ({ ok: true, version: "0.37.1" }));
    engine.get("/video/api/me", async (request, reply) => (request.headers["x-isputnik-gateway"] === SECRET ? { id: "admin" } : reply.code(401).send({})));
    engine.get("/video/api/admin/diagnostics", async (request, reply) => {
      if (request.headers["x-isputnik-gateway"] !== SECRET) return reply.code(401).send({});
      return {
        engine: { name: "isputnik.video", version: "0.37.1", cpus: 4 },
        gpu: { device: "/dev/dri/renderD128", decode: ["h264", "hevc10"], tonemap: false, recentFailures: [] },
        libraries: [{ name: "Galina cartoons", kind: "movies", folder: "Kids/Galina", titles: 12 }],
        paths: { media: "/media", database: "/config/video.sqlite" },
        log: [JSON.stringify({ level: 50, time: Date.UTC(2026, 10, 13, 3, 0, 0), msg: "ffmpeg failed", stderr: "/media/Kids/Galina/Cartoon.mkv: Invalid data" })]
      };
    });
    await engine.listen({ host: "127.0.0.1", port: 0 });
    const address = engine.server.address();
    engineUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    booted = await bootApp({ plugins: [[diagnosticsPlugin, { settings: { video: { upstream: engineUrl, secret: SECRET }, games: { upstream: "", secret: "" }, faces: { upstream: "", secret: "" } } }]] });
  });

  afterEach(async () => {
    await booted?.app.close();
    booted = null;
    await engine.close();
  });

  const ask = async (who: string, query = "") =>
    booted!.app.inject({ method: "GET", url: `/api/admin/diagnostics${query}`, headers: { cookie: await booted!.signIn(who) } });
  const text = (report: { sections: { title: string; lines: string[] }[] }) =>
    report.sections.map((section) => [`## ${section.title}`, ...section.lines].join("\n")).join("\n\n");

  it("is for an admin only", async () => {
    expect((await ask("mum")).statusCode).toBe(403);
    expect((await ask("admin")).statusCode).toBe(200);
  });

  it("has a section for this server, the containers, the libraries, the failures, and each container with its own", async () => {
    const report = (await ask("admin")).json().report;
    expect(report.sections.map((section: { key: string }) => section.key)).toEqual(["system", "containers", "libraries", "failures", "container:video"]);
    const body = text(report);
    expect(body).toMatch(/version: \d+\.\d+\.\d+/);
    expect(body).toContain("video: answers, version 0.37.1");
    expect(body).toContain("games: not set up");
    expect(body).toContain("library.scan.failed");
    // The container's own facts, and its log as readable lines.
    expect(body).toContain("decode: h264, hevc10");
    expect(body).toContain("2026-11-13 03:00:00 ERROR ffmpeg failed");
  });

  it("hides names, folders and addresses unless asked to include them", async () => {
    const hidden = text((await ask("admin")).json().report);
    for (const secret of ["Galina", "/mnt/user/photos", "Kids/Galina", "/media/Kids", "127.0.0.1", "galina@home.example", SECRET]) {
      expect(hidden, secret).not.toContain(secret);
    }
    expect(hidden).toContain("<path>");
    expect(hidden).toContain("<name>");
    const shown = (await ask("admin", "?private=true")).json().report;
    expect(shown.includesPrivate).toBe(true);
    expect(text(shown)).toContain("Galina photos");
    expect(text(shown)).toContain("/mnt/user/photos/galina");
    // The secret is never in it, either way.
    expect(text(shown)).not.toContain(SECRET);
  });

  it("says so, instead of failing, when a container does not answer", async () => {
    await engine.close();
    const report = (await ask("admin")).json().report;
    expect(text(report)).toMatch(/## video container\n(did not answer|this version)/);
  });
});
