import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { dashboardPlugin } from "../src/core/dashboard.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The Activity tab's date toolbar drives /api/dashboard/activity the way the
// Sign-ins view drives /api/dashboard/signins: same window, same bucketing rule,
// same "compared with the stretch before it". These pin that the six series
// count the right events, that the window edges hold, and that the previous
// window is the equal-length one immediately before.

let app: FastifyInstance;
let admin: string;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(dashboardPlugin);
  instance.post("/test/sign-in/:userId", async (request, reply) => {
    issueSession(reply, (request.params as { userId: string }).userId, request);
    return reply.send({ ok: true });
  });
  await instance.ready();
  return instance;
}

async function signIn(userId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

let seq = 0;
function log(event: string, hoursBack: number): void {
  seq += 1;
  db.prepare("INSERT INTO activity_logs (id, event, actor_user_id, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(
    `log-${seq}`,
    event,
    admin,
    "test",
    new Date(Date.now() - hoursBack * 3_600_000).toISOString()
  );
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

async function activity(from: Date, to: Date, session: string) {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const res = await app.inject({ method: "GET", url: `/api/dashboard/activity?${query}`, headers: { cookie: session } });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(async () => {
  resetDb();
  seq = 0;
  admin = makeUser("boss", "admin");
  app = await buildApp();
});

describe("GET /api/dashboard/activity", () => {
  it("counts each kind of event inside the window, hourly for a short one", async () => {
    log("library.gallery.uploaded", 2);
    log("library.ebook.book_uploaded", 2);
    log("library.audiobook.downloaded", 1);
    log("library.item_trashed", 1);
    log("library.audiobook.played", 3);
    log("library.ebook.read", 3);
    log("library.gallery.viewed", 3);
    log("library.gallery.uploaded", 30); // outside a 24h window

    const session = await signIn(admin);
    const { status, body } = await activity(hoursAgo(24), new Date(), session);
    expect(status).toBe(200);
    expect(body.bucket).toBe("hour");
    expect(body.totals).toEqual({ uploads: 2, downloads: 1, deletes: 1, played: 1, read: 1, viewed: 1 });
    // The chart's buckets add up to the totals — same rows, same window.
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    expect(sum(body.series.uploads)).toBe(2);
    expect(sum(body.series.viewed)).toBe(1);
    expect(body.buckets.length).toBe(body.series.uploads.length);
  });

  it("compares against the equal-length window immediately before", async () => {
    log("library.gallery.uploaded", 1); // this window
    log("library.gallery.uploaded", 30); // previous 24h
    log("library.gallery.uploaded", 31); // previous 24h
    log("library.gallery.uploaded", 60); // before both

    const session = await signIn(admin);
    const { body } = await activity(hoursAgo(24), new Date(), session);
    expect(body.totals.uploads).toBe(1);
    expect(body.previous.uploads).toBe(2);
  });

  it("refuses a reversed range and a non-admin", async () => {
    const member = makeUser("kid", "member");
    const reversed = await activity(new Date(), hoursAgo(24), await signIn(admin));
    expect(reversed.status).toBe(400);
    const forbidden = await activity(hoursAgo(24), new Date(), await signIn(member));
    expect(forbidden.status).toBe(403);
  });
});
