import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db.js";
import {
  anyLiveWindow,
  closeLinkWindow,
  createLinkRequest,
  deviceLinkAccess,
  liveWindowFor,
  listLiveWindows,
  openLinkWindow,
  revokeLinkWindow,
  sweepLinkWindows,
  WINDOW_MINUTES
} from "../src/core/device-link.js";
import { getSecurityPolicy, setSecurityPolicy } from "../src/core/security.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// Registration windows: an admin turning linking on for one person for one hour.
// Everything here is about a door that has to close on its own — so most of it is
// the ways a window stops being live, and the fact that each of them is derived
// rather than stored.

const NO_HEADERS: Record<string, unknown> = {};
const PROXIED = { "x-forwarded-for": "203.0.113.9" };
const LAN = "192.168.1.42";
const OUTSIDE = "203.0.113.10";

function ageWindow(userId: string, iso: string): void {
  db.prepare("UPDATE device_link_windows SET expires_at = ? WHERE user_id = ?").run(iso, userId);
}

function minutesAway(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  delete process.env.TRUST_PROXY_HOPS;
  makeUser("traveller");
  makeUser("someone-else");
  makeUser("boss", "admin");
});

describe("opening one", () => {
  it("lasts an hour and belongs to one person", () => {
    const window = openLinkWindow("traveller", "boss");
    expect(window.user_id).toBe("traveller");
    expect(window.created_by).toBe("boss");

    const minutes = (Date.parse(window.expires_at) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(WINDOW_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(WINDOW_MINUTES);

    expect(liveWindowFor("traveller")?.id).toBe(window.id);
    expect(liveWindowFor("someone-else")).toBeNull();
  });

  it("replaces an existing one instead of stacking a second", () => {
    const first = openLinkWindow("traveller", "boss");
    const second = openLinkWindow("traveller", "boss");

    expect(liveWindowFor("traveller")?.id).toBe(second.id);
    expect(listLiveWindows()).toHaveLength(1);
    // The first is closed, not deleted — the grant still happened.
    const rows = db.prepare("SELECT id, revoked_at FROM device_link_windows ORDER BY created_at").all() as
      { id: string; revoked_at: string | null }[];
    expect(rows.find((r) => r.id === first.id)?.revoked_at).toBeTruthy();
  });
});

describe("stopping being live", () => {
  it("closes when a device links against it", () => {
    const window = openLinkWindow("traveller", "boss");
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at, kind) VALUES ('s1', 'h', 'traveller', ?, 'device')"
    ).run(minutesAway(60));

    closeLinkWindow(window.id, "s1");

    expect(liveWindowFor("traveller")).toBeNull();
    expect(anyLiveWindow()).toBe(false);
    const row = db.prepare("SELECT * FROM device_link_windows WHERE id = ?").get(window.id) as
      { used_at: string; session_id: string };
    expect(row.used_at).toBeTruthy();
    expect(row.session_id).toBe("s1");
  });

  it("cannot be spent twice", () => {
    const window = openLinkWindow("traveller", "boss");
    closeLinkWindow(window.id, null);
    const firstUse = (db.prepare("SELECT used_at FROM device_link_windows WHERE id = ?").get(window.id) as
      { used_at: string }).used_at;

    closeLinkWindow(window.id, "later-session");

    const row = db.prepare("SELECT used_at, session_id FROM device_link_windows WHERE id = ?").get(window.id) as
      { used_at: string; session_id: string | null };
    expect(row.used_at).toBe(firstUse);
    expect(row.session_id).toBeNull();
  });

  it("closes when the admin cancels it", () => {
    openLinkWindow("traveller", "boss");
    expect(revokeLinkWindow("traveller")).toBe(true);
    expect(liveWindowFor("traveller")).toBeNull();
    // …and says so when there was nothing open.
    expect(revokeLinkWindow("traveller")).toBe(false);
    expect(revokeLinkWindow("someone-else")).toBe(false);
  });

  it("closes on its own when the hour is up", () => {
    openLinkWindow("traveller", "boss");
    ageWindow("traveller", minutesAway(-1));
    expect(liveWindowFor("traveller")).toBeNull();
    expect(anyLiveWindow()).toBe(false);
  });
});

describe("deviceLinkAccess", () => {
  it("lets the house in without any window, and marks it local", () => {
    expect(deviceLinkAccess(LAN, NO_HEADERS)).toEqual({ allowed: true, remote: false });
    expect(deviceLinkAccess("127.0.0.1", NO_HEADERS)).toEqual({ allowed: true, remote: false });
  });

  it("refuses outside when nothing is open", () => {
    expect(deviceLinkAccess(OUTSIDE, NO_HEADERS)).toEqual({ allowed: false, reason: "scope" });
  });

  it("lets outside in while any window is open, and marks it remote", () => {
    openLinkWindow("traveller", "boss");
    expect(deviceLinkAccess(OUTSIDE, NO_HEADERS)).toEqual({ allowed: true, remote: true });
  });

  it("still marks a request from the house as local while a window is open", () => {
    // Whoever is at home during someone else's window is not doing something remote.
    openLinkWindow("traveller", "boss");
    expect(deviceLinkAccess(LAN, NO_HEADERS)).toEqual({ allowed: true, remote: false });
  });

  it("shuts again the moment the window is spent", () => {
    const window = openLinkWindow("traveller", "boss");
    expect(deviceLinkAccess(OUTSIDE, NO_HEADERS).allowed).toBe(true);
    closeLinkWindow(window.id, null);
    expect(deviceLinkAccess(OUTSIDE, NO_HEADERS)).toEqual({ allowed: false, reason: "scope" });
  });

  it("overrides the misconfigured-proxy refusal, which is the deliberate decision here", () => {
    // Without a window this state refuses everything, because "local" is unknowable.
    expect(deviceLinkAccess(LAN, PROXIED)).toEqual({ allowed: false, reason: "proxy" });
    // A window says location doesn't matter for the next hour, so the question is moot.
    openLinkWindow("traveller", "boss");
    expect(deviceLinkAccess(LAN, PROXIED)).toEqual({ allowed: true, remote: true });
  });

  it("is unnecessary when the policy is already wide open", () => {
    setSecurityPolicy({ ...getSecurityPolicy(), deviceLinkScope: "any" }, null);
    expect(deviceLinkAccess(OUTSIDE, NO_HEADERS)).toEqual({ allowed: true, remote: false });
  });
});

describe("requests remember where they came from", () => {
  it("records remote, and defaults to local", () => {
    const home = createLinkRequest({ ip: LAN });
    const away = createLinkRequest({ ip: OUTSIDE, remote: true });

    const rows = db.prepare("SELECT id, remote FROM device_link_requests").all() as { id: string; remote: number }[];
    expect(rows.find((r) => r.id === home.id)?.remote).toBe(0);
    expect(rows.find((r) => r.id === away.id)?.remote).toBe(1);
  });
});

describe("sweeping", () => {
  it("clears out what is a day past over and leaves everything else", () => {
    openLinkWindow("traveller", "boss");
    openLinkWindow("someone-else", "boss");
    ageWindow("someone-else", minutesAway(-60 * 25));

    expect(sweepLinkWindows()).toBe(1);
    expect(listLiveWindows().map((w) => w.user_id)).toEqual(["traveller"]);
  });
});
