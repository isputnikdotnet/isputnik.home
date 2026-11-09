// The household PIN that locks a restricted viewing profile (modules/profiles/pins.ts,
// docs/tv-profiles-plan.md). Going into Kids is free; leaving it needs the PIN once there
// is one — on a TV and in a browser — and wrong guesses are capped. A TV in a locked
// profile also can't sign out or reach the account's own settings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { profilesPlugin } from "../src/modules/profiles/index.js";
import { PIN_LOCK_MINUTES, PIN_MAX_FAILURES, checkPin } from "../src/modules/profiles/pins.js";
import { lockedOut } from "../src/modules/profiles/fence.js";
import { bootApp, type BootedApp, type TestSession } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const PASSWORD = "correct horse battery";
let booted: BootedApp;
let admin: TestSession;
let tv: TestSession;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("dad", "member");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = 'admin'").run(await hashPassword(PASSWORD));
  booted = await bootApp({
    plugins: [profilesPlugin],
    afterRegister: (app) => {
      // Stand-ins for the routes a locked TV is refused, as core registers them.
      app.patch("/api/profile", { preHandler: app.authenticate }, async () => ({ ok: true }));
      app.post("/api/auth/logout", { preHandler: app.authenticate }, async () => ({ ok: true }));
    }
  });
  admin = await booted.session("admin");
  tv = await booted.session("dad", { kind: "device" });
});

afterEach(async () => {
  await booted.app.close();
});

const web = () => booted.as(admin.cookie);
const remote = () => booted.as(tv.cookie);
const setPin = (pin = "4321", currentPassword = PASSWORD) => web().put("/api/profiles/pin", { pin, currentPassword });
const makeKids = async () => (await web().post("/api/profiles", { name: "Kids", avatar: "green", restricted: true })).json().profile.id as string;
const makeOpen = async () => (await web().post("/api/profiles", { name: "Russian", avatar: "red" })).json().profile.id as string;

describe("setting the PIN", () => {
  it("is an admin's, with their password, and is never shown back", async () => {
    expect((await setPin("4321", "wrong")).statusCode).toBe(403);
    const res = await setPin();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pinSet: true });
    expect(JSON.stringify(res.json())).not.toContain("4321");
    expect(String((db.prepare("SELECT pin_hash FROM viewing_profile_pin").get() as { pin_hash: string }).pin_hash)).toMatch(/^scrypt:/);
    const member = await booted.session("dad");
    expect((await booted.as(member.cookie).put("/api/profiles/pin", { pin: "1111", currentPassword: PASSWORD })).statusCode).toBe(403);
    expect((await remote().put("/api/profiles/pin", { pin: "1111", currentPassword: PASSWORD })).statusCode).toBe(403);
  });

  it("is 4 to 8 digits", async () => {
    expect((await setPin("123")).statusCode).toBe(400);
    expect((await setPin("12a4")).statusCode).toBe(400);
    expect((await setPin("123456789")).statusCode).toBe(400);
    expect((await setPin("12345678")).statusCode).toBe(200);
  });

  it("can be removed with the password", async () => {
    await setPin();
    expect((await web().delete("/api/profiles/pin", { currentPassword: "nope" })).statusCode).toBe(403);
    expect((await web().delete("/api/profiles/pin", { currentPassword: PASSWORD })).json()).toMatchObject({ pinSet: false });
  });
});

describe("leaving a restricted profile", () => {
  it("is free into it, and needs the PIN out of it", async () => {
    await setPin();
    const kids = await makeKids();
    const open = await makeOpen();
    const into = await remote().post("/api/profiles/switch", { profileId: kids });
    expect(into.json()).toMatchObject({ current: kids, locked: true });

    expect((await remote().post("/api/profiles/switch", { profileId: null })).json().reason).toBe("pin_needed");
    expect((await remote().post("/api/profiles/switch", { profileId: open })).json().reason).toBe("pin_needed");
    const wrong = await remote().post("/api/profiles/switch", { profileId: null, pin: "0000" });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ reason: "pin_wrong", triesLeft: PIN_MAX_FAILURES - 1 });
    expect(db.prepare("SELECT profile_id FROM sessions WHERE id = ?").get(tv.id)).toEqual({ profile_id: kids });

    const right = await remote().post("/api/profiles/switch", { profileId: null, pin: "4321" });
    expect(right.json()).toMatchObject({ current: null, locked: false });
  });

  it("needs the PIN in a browser too, and an admin in Kids can't loosen it", async () => {
    await setPin();
    const kids = await makeKids();
    await web().post("/api/profiles/switch", { profileId: kids });
    expect((await web().post("/api/profiles/switch", { profileId: null })).json().reason).toBe("pin_needed");
    expect((await web().get("/api/profiles")).json()).toMatchObject({ locked: true, editable: false });
    expect((await web().patch(`/api/profiles/${kids}`, { name: "Kids", avatar: "green", restricted: false })).statusCode).toBe(403);
    expect((await web().delete("/api/profiles/pin", { currentPassword: PASSWORD })).statusCode).toBe(403);
  });

  it("is free while there is no PIN, and never applies to an open profile", async () => {
    const kids = await makeKids();
    await remote().post("/api/profiles/switch", { profileId: kids });
    expect((await remote().post("/api/profiles/switch", { profileId: null })).statusCode).toBe(200);
    await setPin();
    const open = await makeOpen();
    await remote().post("/api/profiles/switch", { profileId: open });
    expect((await remote().post("/api/profiles/switch", { profileId: null })).statusCode).toBe(200);
  });

  it("locks entry after too many wrong PINs, even for the right one", async () => {
    await setPin();
    const kids = await makeKids();
    await remote().post("/api/profiles/switch", { profileId: kids });
    for (let n = 1; n < PIN_MAX_FAILURES; n++) {
      expect((await remote().post("/api/profiles/switch", { profileId: null, pin: "0000" })).statusCode).toBe(403);
    }
    const locked = await remote().post("/api/profiles/switch", { profileId: null, pin: "0000" });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().reason).toBe("pin_locked");
    expect((await remote().post("/api/profiles/switch", { profileId: null, pin: "4321" })).statusCode).toBe(429);
  });

  it("checks the PIN for what the TV does on its own side", async () => {
    await setPin();
    const kids = await makeKids();
    expect((await remote().post("/api/profiles/pin/check", { pin: "" })).json()).toEqual({ ok: true });
    await remote().post("/api/profiles/switch", { profileId: kids });
    expect((await remote().post("/api/profiles/pin/check", { pin: "0000" })).json()).toMatchObject({ reason: "pin_wrong" });
    expect((await remote().post("/api/profiles/pin/check", { pin: "4321" })).json()).toEqual({ ok: true });
  });

  it("refuses a locked TV the account's settings and signing out, but not a browser", async () => {
    await setPin();
    const kids = await makeKids();
    await remote().post("/api/profiles/switch", { profileId: kids });
    expect((await remote().patch("/api/profile", {})).statusCode).toBe(403);
    expect((await remote().post("/api/auth/logout", {})).statusCode).toBe(403);
    expect((await remote().get("/api/profiles")).statusCode).toBe(200);
    await remote().post("/api/profiles/switch", { profileId: null, pin: "4321" });
    expect((await remote().post("/api/auth/logout", {})).statusCode).toBe(200);
    // A browser in Kids keeps the rest of the site: a profile is a video thing there.
    const dad = await booted.session("dad");
    await booted.as(dad.cookie).post("/api/profiles/switch", { profileId: kids });
    expect((await booted.as(dad.cookie).patch("/api/profile", {})).statusCode).toBe(200);
  });
});

describe("the PIN check", () => {
  it("lets the count start again once a lock has run out", async () => {
    await setPin();
    db.prepare("UPDATE viewing_profile_pin SET failures = ?, locked_until = ?").run(PIN_MAX_FAILURES, new Date(Date.now() - 1000).toISOString());
    expect(await checkPin("0000")).toEqual({ ok: false, locked: false, triesLeft: PIN_MAX_FAILURES - 1 });
    const later = new Date(Date.now() + (PIN_LOCK_MINUTES + 1) * 60_000);
    expect(await checkPin("4321", later)).toEqual({ ok: true });
  });

  it("fences whole path segments", () => {
    expect(lockedOut("/api/profile")).toBe(true);
    expect(lockedOut("/api/profile/theme")).toBe(true);
    expect(lockedOut("/api/profiles")).toBe(false);
    expect(lockedOut("/api/profiles/switch")).toBe(false);
    expect(lockedOut("/api/account/stremio")).toBe(true);
  });
});
