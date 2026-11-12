import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "../src/db.js";
import { dashboardPlugin } from "../src/modules/dashboard/index.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The Activity tab's date toolbar drives /api/dashboard/activity the way the
// Sign-ins view drives /api/dashboard/signins: same window, same bucketing rule,
// same "compared with the stretch before it". These pin that the six series
// count the right events, that the window edges hold, and that the previous
// window is the equal-length one immediately before.

let app: FastifyInstance;
let admin: string;
let signIn: (userId: string) => Promise<string>;

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
  ({ app, signIn } = await bootApp({ plugins: [dashboardPlugin] }));
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
    log("library.video.played", 4);
    log("games.match_started", 5);
    log("library.gallery.uploaded", 30); // outside a 24h window

    const session = await signIn(admin);
    const { status, body } = await activity(hoursAgo(24), new Date(), session);
    expect(status).toBe(200);
    expect(body.bucket).toBe("hour");
    expect(body.totals).toEqual({ uploads: 2, downloads: 1, deletes: 1, played: 1, read: 1, viewed: 1, watched: 1, matches: 1 });
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

  // Control panel v2: an application links here with its event prefixes.
  it("narrows every count to the event prefixes asked for", async () => {
    log("library.gallery.uploaded", 2);
    log("library.ebook.book_uploaded", 2);
    log("photo_sync.connected", 2);
    log("photoXsync.connected", 2);
    const session = await signIn(admin);
    const query = new URLSearchParams({ from: hoursAgo(5).toISOString(), to: new Date().toISOString() });
    query.append("eventPrefix", "library.gallery.");
    const res = await app.inject({ method: "GET", url: `/api/dashboard/activity?${query}`, headers: { cookie: session } });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.uploads).toBe(1);
  });

  // Control panel v2's Usage: who did the counted things in the window, most first.
  it("names the most active members in the window, narrowed like the counts", async () => {
    const sam = makeUser("sam");
    const log2 = (actor: string, event: string) => {
      seq += 1;
      db.prepare("INSERT INTO activity_logs (id, event, actor_user_id, detail, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(`m-${seq}`, event, actor, "test", new Date(Date.now() - 3_600_000).toISOString());
    };
    log2(sam, "library.gallery.viewed");
    log2(sam, "library.gallery.viewed");
    log2(sam, "auth.login");
    log2(admin, "library.ebook.read");
    const session = await signIn(admin);
    const query = new URLSearchParams({ from: hoursAgo(5).toISOString(), to: new Date().toISOString() });
    const all = await app.inject({ method: "GET", url: `/api/dashboard/activity?${query}`, headers: { cookie: session } });
    expect(all.json().members).toEqual([{ id: sam, name: expect.any(String), events: 2 }, { id: admin, name: expect.any(String), events: 1 }]);
    query.append("eventPrefix", "library.ebook.");
    const books = await app.inject({ method: "GET", url: `/api/dashboard/activity?${query}`, headers: { cookie: session } });
    expect(books.json().members.map((member: { id: string }) => member.id)).toEqual([admin]);
  });
});
