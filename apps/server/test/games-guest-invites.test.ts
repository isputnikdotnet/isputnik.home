// Guest links into the games (modules/games/guest-invites.ts): a member mints a
// link for someone with no account, the link becomes a guest cookie, and the
// gateway forwards a guest identity scoped to that one match. The games server
// is a stand-in that records the match the home server created and echoes the
// headers every proxied request carried.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { gamesPlugin } from "../src/modules/games/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "gateway-secret-for-tests";
const HTML = "text/html,application/xhtml+xml,*/*;q=0.8";

let upstream: FastifyInstance;
let booted: BootedApp;
/** What the stand-in games server was asked to create. */
let createdMatches: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];

beforeEach(async () => {
  resetDb();
  makeUser("mum", "member");
  makeUser("dad", "member");
  makeUser("admin", "admin");
  db.prepare("UPDATE users SET display_name = 'Мама', language = 'ru' WHERE id = 'mum'").run();
  createdMatches = [];

  upstream = Fastify();
  upstream.post("/games/api/matches", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    createdMatches.push({ headers: request.headers, body });
    if (body.game === "chess") return reply.code(400).send({ error: "Unknown game" });
    return reply.code(201).send({ id: "m1", game: body.game, status: "invited", players: [{ id: "mum", name: "Мама" }, body.opponent] });
  });
  upstream.all("/games/*", async (request, reply) => reply.send({ url: request.url, headers: request.headers }));
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  const upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  booted = await bootApp({ plugins: [[gamesPlugin, { upstream: upstreamUrl, secret: SECRET }]] });
});

afterEach(async () => {
  await booted.app.close();
  await upstream.close();
});

const mint = async (cookie: string, over: Record<string, unknown> = {}) =>
  booted.app.inject({
    method: "POST",
    url: "/api/games/guest-invites",
    headers: { cookie },
    payload: { game: "dots", options: { size: 10, targetCaptures: null }, seat: 1, guestName: "  Alex  ", ...over }
  });

const linkPath = (url: string) => new URL(url).pathname;
const guestCookie = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers["set-cookie"];
  const line = (Array.isArray(raw) ? raw : [raw]).find((c) => typeof c === "string" && c.startsWith("isputnik_guest=")) as string | undefined;
  return line ? line.split(";")[0] : undefined;
};
const activity = (event: string) =>
  db.prepare("SELECT detail, actor_user_id, ip_address FROM activity_logs WHERE event = ?").all(event) as { detail: string; actor_user_id: string | null; ip_address: string | null }[];
const abuseHits = () => (db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE kind = 'token'").get() as { n: number }).n;

describe("minting a guest link", () => {
  it("creates the match on the games server in the member's name and hands the link back once", async () => {
    const cookie = await booted.signIn("mum");
    const res = await mint(cookie);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { invite: Record<string, unknown>; url: string; match: Record<string, unknown> };
    expect(body.url).toMatch(new RegExp(`^${config.appUrl.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/games/guest/[A-Za-z0-9]{32}$`));
    expect(body.match).toMatchObject({ id: "m1", game: "dots" });
    expect(body.invite).toMatchObject({ guestName: "Alex", game: "dots", matchId: "m1", state: "live", openedCount: 0, createdBy: { id: "mum", name: "Мама" } });
    expect(body.invite).not.toHaveProperty("token");

    // The games server saw mum herself invite the guest, with the id this server chose.
    expect(createdMatches).toHaveLength(1);
    const [created] = createdMatches;
    expect(created.headers["x-isputnik-gateway"]).toBe(SECRET);
    expect(created.headers["x-isputnik-user-id"]).toBe("mum");
    expect(created.headers["x-isputnik-user-role"]).toBe("member");
    expect(created.body).toMatchObject({ game: "dots", seat: 1, options: { size: 10, targetCaptures: null }, opponent: { name: "Alex" } });
    expect((created.body.opponent as { id: string }).id).toMatch(/^guest_[0-9a-z]{12}$/);
    expect((created.body.opponent as { id: string }).id).toBe(body.invite.guestId);

    expect(activity("games.guest_invite.created")).toEqual([{ detail: "Мама invited Alex to a dots match by guest link.", actor_user_id: "mum", ip_address: "127.0.0.1" }]);
  });

  it("leaves nothing behind when the games server refuses, and forwards why", async () => {
    const cookie = await booted.signIn("mum");
    const res = await mint(cookie, { game: "chess" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Unknown game" });
    expect((await booted.app.inject({ method: "GET", url: "/api/games/guest-invites", headers: { cookie } })).json()).toEqual({ invites: [] });
    expect((db.prepare("SELECT COUNT(*) AS n FROM games_guest_invites").get() as { n: number }).n).toBe(0);
  });

  it("needs a signed-in member and a name for the guest", async () => {
    expect((await booted.app.inject({ method: "POST", url: "/api/games/guest-invites", payload: {} })).statusCode).toBe(401);
    const res = await mint(await booted.signIn("mum"), { guestName: "   " });
    expect(res.statusCode).toBe(400);
    expect(createdMatches).toHaveLength(0);
  });
});

describe("opening a guest link", () => {
  it("sets the guest cookie, sends the browser to the match, and counts the open", async () => {
    const cookie = await booted.signIn("mum");
    const { url, invite } = (await mint(cookie)).json() as { url: string; invite: { id: string } };

    const opened = await booted.app.inject({ method: "GET", url: linkPath(url), headers: { accept: HTML }, remoteAddress: "203.0.113.9" });
    expect(opened.statusCode).toBe(302);
    expect(opened.headers.location).toBe("/games/dots/m/m1");
    const set = (Array.isArray(opened.headers["set-cookie"]) ? opened.headers["set-cookie"] : [opened.headers["set-cookie"]]).join("\n");
    expect(set).toMatch(/^isputnik_guest=[A-Za-z0-9]{32}; /m);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");

    const listed = (await booted.app.inject({ method: "GET", url: "/api/games/guest-invites?match=m1", headers: { cookie } })).json() as { invites: Record<string, unknown>[] };
    expect(listed.invites).toHaveLength(1);
    expect(listed.invites[0]).toMatchObject({ id: invite.id, openedCount: 1, lastIp: "203.0.113.9" });
    expect(listed.invites[0].firstOpenedAt).toEqual(expect.any(String));
    expect(activity("games.guest_invite.opened")).toEqual([{ detail: "Alex opened the guest link to the dots match.", actor_user_id: null, ip_address: "203.0.113.9" }]);
    expect(abuseHits()).toBe(0);
  });

  it("reaches the games as a guest of that one match, with nothing the browser sent", async () => {
    const { url } = (await mint(await booted.signIn("mum"))).json() as { url: string };
    const guest = guestCookie(await booted.app.inject({ method: "GET", url: linkPath(url) }))!;

    const res = await booted.app.inject({
      method: "GET",
      url: "/games/api/me",
      headers: { cookie: guest, "x-isputnik-user-id": "admin", "x-isputnik-user-role": "admin", "x-isputnik-guest-match": "other" }
    });
    expect(res.statusCode).toBe(200);
    const headers = (res.json() as { headers: Record<string, string> }).headers;
    expect(headers["x-isputnik-gateway"]).toBe(SECRET);
    expect(headers["x-isputnik-user-role"]).toBe("guest");
    expect(headers["x-isputnik-user-id"]).toMatch(/^guest_/);
    expect(decodeURIComponent(headers["x-isputnik-user-name"])).toBe("Alex");
    expect(headers["x-isputnik-guest-match"]).toBe("m1");
    // The inviter's language, a theme that follows the device, and the usual log fields.
    expect(headers["x-isputnik-user-lang"]).toBe("ru");
    expect(headers["x-isputnik-user-theme"]).toBe("system");
    expect(headers["x-isputnik-client-ip"]).toBe("127.0.0.1");
    expect(headers["x-isputnik-request-id"]).toMatch(/^req-/);
    // The pages too, not just the API.
    expect((await booted.app.inject({ method: "GET", url: "/games/dots/m/m1", headers: { cookie: guest, accept: HTML } })).statusCode).toBe(200);
  });

  it("lets a member's own session win over a guest cookie in the same browser", async () => {
    const mum = await booted.signIn("mum");
    const { url } = (await mint(mum)).json() as { url: string };
    const guest = guestCookie(await booted.app.inject({ method: "GET", url: linkPath(url) }))!;
    const dad = await booted.signIn("dad");

    const res = await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: `${dad}; ${guest}` } });
    const headers = (res.json() as { headers: Record<string, string> }).headers;
    expect(headers["x-isputnik-user-id"]).toBe("dad");
    expect(headers["x-isputnik-user-role"]).toBe("member");
    expect(headers["x-isputnik-guest-match"]).toBeUndefined();

    // A signed-in member opening a link is sent to the match as themselves; no guest cookie.
    const opened = await booted.app.inject({ method: "GET", url: linkPath(url), headers: { cookie: mum, accept: HTML } });
    expect(opened.statusCode).toBe(302);
    expect(opened.headers.location).toBe("/games/dots/m/m1");
    expect(guestCookie(opened)).toBeUndefined();
  });

  it("refuses a dead link with the page for a navigation and a 401 for the API, and keeps the cookie so the page keeps explaining", async () => {
    const cookie = await booted.signIn("mum");
    const { url, invite } = (await mint(cookie)).json() as { url: string; invite: { id: string } };
    const guest = guestCookie(await booted.app.inject({ method: "GET", url: linkPath(url) }))!;

    const revoked = await booted.app.inject({ method: "DELETE", url: `/api/games/guest-invites/${invite.id}`, headers: { cookie } });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { invite: { state: string } }).invite.state).toBe("revoked");
    expect(activity("games.guest_invite.revoked")).toHaveLength(1);

    const page = await booted.app.inject({ method: "GET", url: "/games/dots/m/m1", headers: { cookie: guest, accept: HTML } });
    expect(page.statusCode).toBe(410);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("This game link no longer works");
    expect(page.headers["set-cookie"]).toBeUndefined();

    const api = await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: guest } });
    expect(api.statusCode).toBe(401);
    expect(api.json()).toEqual({ error: "This game link no longer works", guest: true });
    // The API's 401 did not take the cookie away: the next page the guest opens still explains.
    expect((await booted.app.inject({ method: "GET", url: "/games/", headers: { cookie: guest, accept: HTML } })).statusCode).toBe(410);

    // Opening the old link again: the same page, in the browser's language, and no abuse counted.
    const again = await booted.app.inject({ method: "GET", url: linkPath(url), headers: { accept: HTML, "accept-language": "ru-RU,ru;q=0.9" } });
    expect(again.statusCode).toBe(410);
    expect(again.body).toContain("больше не работает");
    expect(abuseHits()).toBe(0);
  });

  it("treats an expired link the same way", async () => {
    const { url } = (await mint(await booted.signIn("mum"))).json() as { url: string };
    const guest = guestCookie(await booted.app.inject({ method: "GET", url: linkPath(url) }))!;
    db.prepare("UPDATE games_guest_invites SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: guest } })).statusCode).toBe(401);
    expect((await booted.app.inject({ method: "GET", url: linkPath(url) })).statusCode).toBe(410);
  });

  it("counts a token that matches nothing as a guess against its source address", async () => {
    const res = await booted.app.inject({ method: "GET", url: "/games/guest/nope-nope-nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "This game link no longer works" });
    expect(abuseHits()).toBe(1);
    const page = await booted.app.inject({ method: "GET", url: "/games/guest/nope-nope-nope", headers: { accept: HTML } });
    expect(page.statusCode).toBe(404);
    expect(page.headers["content-type"]).toContain("text/html");
  });
});

describe("managing guest links", () => {
  it("renews a link: the old one dies at once, the new one works", async () => {
    const cookie = await booted.signIn("mum");
    const { url, invite } = (await mint(cookie)).json() as { url: string; invite: { id: string } };
    const oldGuest = guestCookie(await booted.app.inject({ method: "GET", url: linkPath(url) }))!;

    const renewed = await booted.app.inject({ method: "POST", url: `/api/games/guest-invites/${invite.id}/renew`, headers: { cookie } });
    expect(renewed.statusCode).toBe(200);
    const fresh = renewed.json() as { url: string; invite: { id: string; state: string } };
    expect(fresh.url).not.toBe(url);
    expect(fresh.invite).toMatchObject({ id: invite.id, state: "live" });
    expect(activity("games.guest_invite.renewed")).toHaveLength(1);

    expect((await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: oldGuest } })).statusCode).toBe(401);
    expect((await booted.app.inject({ method: "GET", url: linkPath(url) })).statusCode).toBe(410);
    const opened = await booted.app.inject({ method: "GET", url: linkPath(fresh.url) });
    expect(opened.statusCode).toBe(302);
    const headers = (await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: guestCookie(opened)! } })).json() as { headers: Record<string, string> };
    expect(headers.headers["x-isputnik-user-role"]).toBe("guest");
  });

  it("shows a member their own links only, and an admin everyone's", async () => {
    const mum = await booted.signIn("mum");
    const dad = await booted.signIn("dad");
    const admin = await booted.signIn("admin");
    const { invite } = (await mint(mum)).json() as { invite: { id: string } };

    expect((await booted.app.inject({ method: "GET", url: "/api/games/guest-invites", headers: { cookie: dad } })).json()).toEqual({ invites: [] });
    expect((await booted.app.inject({ method: "GET", url: "/api/games/guest-invites?all=1", headers: { cookie: dad } })).json()).toEqual({ invites: [] });
    expect((await booted.app.inject({ method: "POST", url: `/api/games/guest-invites/${invite.id}/renew`, headers: { cookie: dad } })).statusCode).toBe(404);
    expect((await booted.app.inject({ method: "DELETE", url: `/api/games/guest-invites/${invite.id}`, headers: { cookie: dad } })).statusCode).toBe(404);

    const all = (await booted.app.inject({ method: "GET", url: "/api/games/guest-invites?all=1", headers: { cookie: admin } })).json() as { invites: { id: string; createdBy: { name: string } }[] };
    expect(all.invites.map((i) => [i.id, i.createdBy.name])).toEqual([[invite.id, "Мама"]]);
    const revoked = await booted.app.inject({ method: "DELETE", url: `/api/games/guest-invites/${invite.id}`, headers: { cookie: admin } });
    expect((revoked.json() as { invite: { state: string } }).invite.state).toBe("revoked");
    expect((await booted.app.inject({ method: "POST", url: `/api/games/guest-invites/${invite.id}/renew`, headers: { cookie: mum } })).statusCode).toBe(200);
  });
});
