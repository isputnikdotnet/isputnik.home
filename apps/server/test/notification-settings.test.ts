// Notification settings: what the app may email ordinary members about. Two rules
// carry the whole tab — everything is off until switched on, and nothing can be
// switched on while there is nowhere to send it.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { notificationsPlugin } from "../src/core/notification-routes.js";
import { getNotificationSettings, shareNotificationsEnabled } from "../src/core/notifications.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;

function configureMail(): void {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('mail_settings', ?)").run(
    JSON.stringify({
      host: "smtp.test", port: 587, secure: false, username: "",
      password: "", fromAddress: "home@test.local", fromName: "Home"
    })
  );
}

const get = (userId = "admin") =>
  app.inject({ method: "GET", url: "/api/config/notifications", headers: { "x-test-user": userId } });

const put = (body: unknown, userId = "admin") =>
  app.inject({ method: "PUT", url: "/api/config/notifications", payload: body, headers: { "x-test-user": userId } });

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("member");

  app = fastify();
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
  await app.register(notificationsPlugin);
  await app.ready();
});

describe("notification settings", () => {
  it("is off on a fresh install, with nothing stored", async () => {
    expect(getNotificationSettings()).toEqual({ shareNotifications: false });
    const response = await get();
    expect(response.json()).toEqual({
      notifications: { shareNotifications: false },
      mailConfigured: false
    });
  });

  it("reports whether mail is configured, so the page can grey itself out", async () => {
    expect((await get()).json().mailConfigured).toBe(false);
    configureMail();
    expect((await get()).json().mailConfigured).toBe(true);
  });

  it("refuses to switch anything on while there is nowhere to send it", async () => {
    const response = await put({ shareNotifications: true });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/email server/i);
    // And nothing was written on the way to the refusal.
    expect(getNotificationSettings().shareNotifications).toBe(false);
  });

  it("saves once there is a mail server, and the feature gate follows", async () => {
    configureMail();
    expect(shareNotificationsEnabled()).toBe(false);

    const response = await put({ shareNotifications: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().notifications).toEqual({ shareNotifications: true });
    expect(shareNotificationsEnabled()).toBe(true);
  });

  it("stops notifying if the mail server is later taken away, without changing the switch", async () => {
    configureMail();
    await put({ shareNotifications: true });

    db.prepare("DELETE FROM app_settings WHERE key = 'mail_settings'").run();
    // The admin's answer is still on record — it simply cannot be acted on.
    expect(getNotificationSettings().shareNotifications).toBe(true);
    expect(shareNotificationsEnabled()).toBe(false);
  });

  it("can always be switched off, mail server or not", async () => {
    configureMail();
    await put({ shareNotifications: true });
    db.prepare("DELETE FROM app_settings WHERE key = 'mail_settings'").run();

    const response = await put({ shareNotifications: false });
    expect(response.statusCode).toBe(200);
    expect(getNotificationSettings().shareNotifications).toBe(false);
  });

  it("is admin-only, and records the change", async () => {
    configureMail();
    expect((await get("member")).statusCode).toBe(403);
    expect((await put({ shareNotifications: true }, "member")).statusCode).toBe(403);

    await put({ shareNotifications: true });
    const log = db.prepare(
      "SELECT detail FROM activity_logs WHERE event = 'config.notifications_updated'"
    ).get() as { detail: string } | undefined;
    expect(log?.detail).toMatch(/on/);
  });

  it("rejects a body that isn't the shape it expects", async () => {
    configureMail();
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ shareNotifications: "yes" })).statusCode).toBe(400);
  });
});
