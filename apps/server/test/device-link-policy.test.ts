import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db.js";
import { addTrustedNetwork, deviceLinkAllowedFrom, getSecurityPolicy, setSecurityPolicy } from "../src/core/security.js";
import { resetDb } from "./helpers/seed.js";

// Where a device may ask to be linked from. The whole point of the control is that
// it fails closed, so most of this file is about the ways it can be talked into
// saying yes when it shouldn't.

const NO_HEADERS: Record<string, unknown> = {};
const PROXIED = { "x-forwarded-for": "203.0.113.9" };

function setScope(scope: "local" | "any") {
  setSecurityPolicy({ ...getSecurityPolicy(), deviceLinkScope: scope }, null);
}

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  delete process.env.TRUST_PROXY_HOPS;
});

afterEach(() => {
  delete process.env.TRUST_PROXY_HOPS;
});

describe("deviceLinkAllowedFrom — default scope", () => {
  it("defaults to local, without anything being configured", () => {
    expect(getSecurityPolicy().deviceLinkScope).toBe("local");
  });

  it("allows a device on the house network", () => {
    expect(deviceLinkAllowedFrom("192.168.1.42", NO_HEADERS)).toEqual({ allowed: true });
    expect(deviceLinkAllowedFrom("10.0.0.7", NO_HEADERS)).toEqual({ allowed: true });
    expect(deviceLinkAllowedFrom("::1", NO_HEADERS)).toEqual({ allowed: true });
  });

  it("refuses a device out on the internet", () => {
    expect(deviceLinkAllowedFrom("203.0.113.10", NO_HEADERS)).toEqual({ allowed: false, reason: "scope" });
  });

  it("allows an address an admin has trusted, even a public one", () => {
    addTrustedNetwork("203.0.113.0/24", "The cabin", null);
    expect(deviceLinkAllowedFrom("203.0.113.10", NO_HEADERS)).toEqual({ allowed: true });
    expect(deviceLinkAllowedFrom("198.51.100.1", NO_HEADERS)).toEqual({ allowed: false, reason: "scope" });
  });

  it("refuses when there is no address to judge", () => {
    expect(deviceLinkAllowedFrom(null, NO_HEADERS)).toEqual({ allowed: false, reason: "scope" });
    expect(deviceLinkAllowedFrom("", NO_HEADERS)).toEqual({ allowed: false, reason: "scope" });
  });
});

describe("deviceLinkAllowedFrom — scope 'any'", () => {
  it("allows a device from anywhere once an admin has opted in", () => {
    setScope("any");
    expect(deviceLinkAllowedFrom("203.0.113.10", NO_HEADERS)).toEqual({ allowed: true });
    expect(deviceLinkAllowedFrom(null, NO_HEADERS)).toEqual({ allowed: true });
  });
});

describe("deviceLinkAllowedFrom — the misconfigured-proxy trap", () => {
  // This is the case the control exists for. A forwarded header means something in
  // front rewrote the connection; with no hop count configured, request.ip is that
  // proxy's own (private!) address, so "is this device local?" would be answered
  // yes for every visitor on earth.
  it("refuses a proxied request when TRUST_PROXY_HOPS is unset, private address and all", () => {
    expect(deviceLinkAllowedFrom("172.18.0.2", PROXIED)).toEqual({ allowed: false, reason: "proxy" });
    expect(deviceLinkAllowedFrom("192.168.1.42", PROXIED)).toEqual({ allowed: false, reason: "proxy" });
  });

  it("refuses ahead of the scope check, so 'any' cannot paper over it", () => {
    setScope("any");
    expect(deviceLinkAllowedFrom("172.18.0.2", PROXIED)).toEqual({ allowed: false, reason: "proxy" });
  });

  it("also catches the RFC 7239 Forwarded header, not just X-Forwarded-For", () => {
    expect(deviceLinkAllowedFrom("172.18.0.2", { forwarded: "for=203.0.113.9" })).toEqual({
      allowed: false,
      reason: "proxy"
    });
  });

  it("allows the same request once the hop count is configured", () => {
    process.env.TRUST_PROXY_HOPS = "1";
    // With hops set, request.ip is the real client, and the ordinary rules apply.
    expect(deviceLinkAllowedFrom("192.168.1.42", PROXIED)).toEqual({ allowed: true });
    expect(deviceLinkAllowedFrom("203.0.113.10", PROXIED)).toEqual({ allowed: false, reason: "scope" });
  });

  it("judges each request on its own headers, so one spoofed header can't switch the feature off", () => {
    // Any client may send X-Forwarded-For. If that latched a process-wide flag,
    // one curious device on the LAN would disable linking for the household until
    // the next restart. The next, header-free request is unaffected.
    expect(deviceLinkAllowedFrom("192.168.1.99", PROXIED)).toEqual({ allowed: false, reason: "proxy" });
    expect(deviceLinkAllowedFrom("192.168.1.42", NO_HEADERS)).toEqual({ allowed: true });
  });
});

describe("security policy storage", () => {
  it("survives a round trip and leaves the other thresholds alone", () => {
    const before = getSecurityPolicy();
    setScope("any");
    const after = getSecurityPolicy();
    expect(after.deviceLinkScope).toBe("any");
    expect(after.lockoutThreshold).toBe(before.lockoutThreshold);
    expect(after.ipAutoblockMinutes).toBe(before.ipAutoblockMinutes);
  });

  it("adopts the safe default when an older policy blob has no opinion", () => {
    // What an install upgrading from 3.4.x actually has on disk.
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('security_policy', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(JSON.stringify({ lockoutThreshold: 9, lockoutMinutes: 45 }));

    const policy = getSecurityPolicy();
    expect(policy.deviceLinkScope).toBe("local");
    expect(policy.lockoutThreshold).toBe(9);
  });
});
