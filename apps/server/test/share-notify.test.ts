// The email a recipient gets when something is shared with them. The interesting
// parts aren't the wording — they're the three gates: the admin toggle, "is this
// actually new access", and the guest links that must stay silent because there is
// no account behind them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";

// Mock only the transport; getMailSettings/userNotificationsEnabled stay real and
// read the in-memory app_settings, which is the guard every notification goes through.
vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}) };
});

import { db } from "../src/db.js";
import { sendMail } from "../src/core/mail.js";
import { librarySharesPlugin } from "../src/modules/library/shared/shares.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

let app: FastifyInstance;

// Notifications are fire-and-forget (`void deliver(…)`), so let the microtask
// queue drain before asserting.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function configureMail(userNotifications = true): void {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('mail_settings', ?)").run(
    JSON.stringify({
      host: "smtp.test",
      port: 587,
      secure: false,
      username: "",
      password: "",
      fromAddress: "home@test.local",
      fromName: "Home",
      userNotifications
    })
  );
}

function makeItem(id: string, opts: { library: string; type: string; title?: string; kind?: "photo" | "video" }): string {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, ?, ?, 'ready')"
  ).run(id, opts.library, opts.type, `/${id}`);
  if (opts.title) {
    db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, ?)").run(id, opts.title);
  }
  if (opts.type === "gallery") {
    db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path) VALUES (?, ?, ?)").run(
      id,
      opts.kind ?? "photo",
      `${id}.jpg`
    );
  }
  return id;
}

async function post(url: string, body: unknown, userId = "sharer") {
  const response = await app.inject({ method: "POST", url, payload: body, headers: { "x-test-user": userId } });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

function sent() {
  return vi.mocked(sendMail).mock.calls.map((call) => call[0]);
}

beforeEach(async () => {
  resetDb();
  vi.clearAllMocks();
  configureMail();

  makeUser("sharer");
  makeUser("friend");
  db.prepare("UPDATE users SET display_name = ? WHERE id = 'sharer'").run("Anna");
  db.prepare("UPDATE users SET display_name = ? WHERE id = 'friend'").run("Boris");

  makeLibrary("GAL", { createdBy: "sharer", type: "gallery" });
  grant("user", "sharer", "GAL", "manager");
  makeLibrary("BOOKS", { createdBy: "sharer", type: "audiobook" });
  grant("user", "sharer", "BOOKS", "manager");

  makeItem("photo-1", { library: "GAL", type: "gallery", title: "Beach day" });
  makeItem("photo-2", { library: "GAL", type: "gallery" });
  makeItem("photo-3", { library: "GAL", type: "gallery" });
  makeItem("book-1", { library: "BOOKS", type: "audiobook", title: "The Hobbit" });

  db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('alb-1', 'Summer 2024', 'sharer')").run();

  app = fastify();
  // Stubbed auth — the real session decorators are core code and out of scope.
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined
      : undefined;
    if (!row) { reply.code(401).send({ error: "Unauthenticated" }); return; }
    request.user = row as never;
  });
  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") reply.code(403).send({ error: "Admin only" });
  });
  await app.register(librarySharesPlugin);
  await app.ready();
});

describe("share notifications", () => {
  it("emails the recipient when a single item is shared, naming sharer and item", async () => {
    const { status } = await post("/api/shares/user", { bookId: "book-1", userId: "friend" });
    expect(status).toBe(201);
    await flush();

    expect(sent()).toHaveLength(1);
    const mail = sent()[0];
    expect(mail.to).toBe("friend@test.local");
    expect(mail.subject).toBe('Anna shared "The Hobbit" with you');
    expect(mail.text).toContain("Hello Boris");
    expect(mail.text).toContain("Anna shared an audiobook with you");
    expect(mail.text).toContain("The Hobbit");
    // The link goes to the app, not to the file.
    expect(mail.text).toContain("/shared");
  });

  it("calls a shared gallery item a photo, and a video a video", async () => {
    makeItem("clip-1", { library: "GAL", type: "gallery", title: "First steps", kind: "video" });
    await post("/api/shares/user", { bookId: "photo-1", userId: "friend" });
    await post("/api/shares/user", { bookId: "clip-1", userId: "friend" });
    await flush();

    expect(sent().map((mail) => mail.subject)).toEqual([
      'Anna shared "Beach day" with you',
      'Anna shared "First steps" with you'
    ]);
    expect(sent()[0].text).toContain("Anna shared a photo with you");
    expect(sent()[1].text).toContain("Anna shared a video with you");
  });

  it("says when the access expires, and stays quiet about it when it doesn't", async () => {
    await post("/api/shares/user", { bookId: "book-1", userId: "friend", expiresInDays: 7 });
    await post("/api/shares/user", { bookId: "photo-1", userId: "friend" });
    await flush();

    expect(sent()[0].text).toMatch(/Your access expires on \d{4}-\d{2}-\d{2}\./);
    expect(sent()[1].text).not.toContain("expires");
  });

  it("does not email again when a share is only refreshed", async () => {
    await post("/api/shares/user", { bookId: "book-1", userId: "friend", expiresInDays: 7 });
    await flush();
    expect(sent()).toHaveLength(1);

    // Same item, same person — the upsert just moves the expiry.
    await post("/api/shares/user", { bookId: "book-1", userId: "friend", expiresInDays: 30 });
    await flush();
    expect(sent()).toHaveLength(1);
  });

  it("emails again once access was revoked and is granted back", async () => {
    await post("/api/shares/user", { bookId: "book-1", userId: "friend" });
    await flush();
    db.prepare("UPDATE shares SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();

    await post("/api/shares/user", { bookId: "book-1", userId: "friend" });
    await flush();
    expect(sent()).toHaveLength(2);
  });

  it("sends one email for a bulk selection, counting only what is new", async () => {
    await post("/api/shares/set/user", { itemIds: ["photo-1", "photo-2", "photo-3"], userId: "friend" });
    await flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toBe("Anna shared 3 photos with you");

    // Re-share the same three plus a fourth: only the fourth is news, and one
    // photo on its own is named rather than counted.
    makeItem("photo-4", { library: "GAL", type: "gallery", title: "Sunset" });
    await post("/api/shares/set/user", { itemIds: ["photo-1", "photo-2", "photo-3", "photo-4"], userId: "friend" });
    await flush();
    expect(sent()).toHaveLength(2);
    expect(sent()[1].subject).toBe('Anna shared "Sunset" with you');

    // Nothing new at all: silence.
    await post("/api/shares/set/user", { itemIds: ["photo-1", "photo-2"], userId: "friend" });
    await flush();
    expect(sent()).toHaveLength(2);
  });

  it("names the album on an album share and says it keeps up to date", async () => {
    const { status } = await post("/api/shares/album/user", { albumId: "alb-1", userId: "friend" });
    expect(status).toBe(201);
    await flush();

    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toBe('Anna shared the album "Summer 2024" with you');
    expect(sent()[0].text).toContain("stays up to date");
  });

  it("sends nothing for a guest link — there is no account behind it", async () => {
    await post("/api/shares", { bookId: "book-1" });
    await post("/api/shares/set", { itemIds: ["photo-1"] });
    await post("/api/shares/album", { albumId: "alb-1" });
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends nothing when the admin has switched user notifications off", async () => {
    configureMail(false);
    await post("/api/shares/user", { bookId: "book-1", userId: "friend" });
    await post("/api/shares/set/user", { itemIds: ["photo-1"], userId: "friend" });
    await post("/api/shares/album/user", { albumId: "alb-1", userId: "friend" });
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends nothing when SMTP isn't configured at all", async () => {
    db.prepare("DELETE FROM app_settings WHERE key = 'mail_settings'").run();
    await post("/api/shares/user", { bookId: "book-1", userId: "friend" });
    await flush();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("still grants the share when the mail transport throws", async () => {
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("relay refused"));
    const { status } = await post("/api/shares/user", { bookId: "book-1", userId: "friend" });
    await flush();

    expect(status).toBe(201);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM shares WHERE user_id = 'friend'").get() as { n: number }
    ).toEqual({ n: 1 });
  });
});
