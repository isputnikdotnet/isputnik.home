// The menu's sections (core/sections.ts): the admin switches Audiobooks, Ebooks,
// Gallery, Family Tree, Stories and Games on and off for the household. Saved
// through /api/config beside the default theme, told to everyone on
// /api/setup/status, and honoured by the games (status + gateway) and the book
// feeds.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { appConfigPlugin } from "../src/core/app-config.js";
import { setupPlugin } from "../src/core/setup.js";
import { gamesPlugin } from "../src/modules/games/index.js";
import { ALL_SECTIONS_ON, bookTypesOn, getSections } from "../src/core/sections.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

let upstream: FastifyInstance;
let booted: BootedApp;

const json = { "content-type": "application/json" };

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  upstream = Fastify();
  upstream.all("/games/*", async (request, reply) => reply.send({ url: request.url }));
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  const upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  booted = await bootApp({
    plugins: [appConfigPlugin, setupPlugin, [gamesPlugin, { upstream: upstreamUrl, secret: "s".repeat(32) }]]
  });
});

afterEach(async () => {
  await booted.app.close();
  await upstream.close();
});

describe("sections", () => {
  it("start all on, and ride on the public status call", async () => {
    expect(getSections()).toEqual(ALL_SECTIONS_ON);
    const status = await booted.app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toMatchObject({ sections: ALL_SECTIONS_ON });
    const config = await booted.app.inject({ method: "GET", url: "/api/config", headers: { cookie: await booted.signIn("admin") } });
    expect(config.json()).toMatchObject({ config: { defaultTheme: "minimalist", sections: ALL_SECTIONS_ON } });
  });

  it("are saved by an admin on their own, leaving the default theme alone", async () => {
    const cookie = await booted.signIn("admin");
    await booted.app.inject({ method: "PATCH", url: "/api/config", headers: { cookie, ...json }, body: { defaultTheme: "plain-dark" } });
    const next = { ...ALL_SECTIONS_ON, audiobooks: false, games: false };
    const res = await booted.app.inject({ method: "PATCH", url: "/api/config", headers: { cookie, ...json }, body: { sections: next } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ config: { defaultTheme: "plain-dark", sections: next } });
    expect(getSections()).toEqual(next);
    // Everyone learns it from the public call; only an admin may change it.
    expect((await booted.app.inject({ method: "GET", url: "/api/setup/status" })).json()).toMatchObject({ sections: next });
    const member = await booted.app.inject({ method: "PATCH", url: "/api/config", headers: { cookie: await booted.signIn("mum"), ...json }, body: { sections: ALL_SECTIONS_ON } });
    expect(member.statusCode).toBe(403);
    expect(bookTypesOn()).toEqual(["ebook"]);
    // The audit line names what went off.
    const detail = db.prepare("SELECT detail FROM activity_logs WHERE target_id = 'sections' ORDER BY rowid DESC LIMIT 1").get() as { detail: string };
    expect(detail.detail).toBe("Sections off: audiobooks, games.");
  });

  it("refuse to switch the last section off, and an empty save", async () => {
    const cookie = await booted.signIn("admin");
    const none = Object.fromEntries(Object.keys(ALL_SECTIONS_ON).map((key) => [key, false]));
    const res = await booted.app.inject({ method: "PATCH", url: "/api/config", headers: { cookie, ...json }, body: { sections: none } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "config.no_sections" });
    expect(getSections()).toEqual(ALL_SECTIONS_ON);
    expect((await booted.app.inject({ method: "PATCH", url: "/api/config", headers: { cookie, ...json }, body: {} })).statusCode).toBe(400);
  });

  it("survive a damaged setting row by falling back to all on", () => {
    db.prepare("INSERT INTO app_settings (key, value, updated_by) VALUES ('sections', 'not json', 'admin')").run();
    expect(getSections()).toEqual(ALL_SECTIONS_ON);
    db.prepare("UPDATE app_settings SET value = ? WHERE key = 'sections'").run(JSON.stringify({ gallery: false, extra: 1 }));
    expect(getSections()).toEqual({ ...ALL_SECTIONS_ON, gallery: false });
  });

  it("take the games away when Games is off: status false and the gateway answers 404", async () => {
    const admin = await booted.signIn("admin");
    const mum = await booted.signIn("mum");
    // GAMES_URL is unset under test, so status reads false either way; the
    // gateway registered by hand shows the switch's effect.
    expect((await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: mum } })).statusCode).toBe(200);
    await booted.app.inject({ method: "PATCH", url: "/api/config", headers: { cookie: admin, ...json }, body: { sections: { ...ALL_SECTIONS_ON, games: false } } });
    expect((await booted.app.inject({ method: "GET", url: "/api/games/status", headers: { cookie: mum } })).json()).toEqual({ enabled: false });
    const gone = await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: mum } });
    expect(gone.statusCode).toBe(404);
    // A page navigation while signed out gets the 404 too, not the sign-in redirect.
    const page = await booted.app.inject({ method: "GET", url: "/games/", headers: { accept: "text/html" } });
    expect(page.statusCode).toBe(404);
    await booted.app.inject({ method: "PATCH", url: "/api/config", headers: { cookie: admin, ...json }, body: { sections: ALL_SECTIONS_ON } });
    expect((await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie: mum } })).statusCode).toBe(200);
  });
});
