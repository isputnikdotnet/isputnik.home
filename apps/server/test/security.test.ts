import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { resetDb } from "./helpers/seed.js";
import {
  isTrustedIp,
  addTrustedNetwork,
  listTrustedNetworks,
  removeTrustedNetwork,
  recordLoginAttempt,
  isAccountLocked,
  clearAccountLockout,
  isIpBlocked,
  blockIp,
  unblockIp,
  listBlockedIps,
  maybeAutoBlockIp,
  DEFAULT_SECURITY_POLICY,
  getSecurityPolicy,
  setSecurityPolicy,
  hasForwardedHeader,
  getTrustProxyHops
} from "../src/core/security.js";

const LOCKOUT_THRESHOLD = DEFAULT_SECURITY_POLICY.lockoutThreshold;
const IP_FAIL_THRESHOLD = DEFAULT_SECURITY_POLICY.ipFailThreshold;

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
});

describe("trusted zones", () => {
  it("trusts nothing by default", () => {
    expect(isTrustedIp("192.168.1.5")).toBe(false);
  });

  it("trusts an IP once its network is added, and stops on removal", () => {
    const id = addTrustedNetwork("192.168.0.0/16", "Home LAN", null);
    expect(isTrustedIp("192.168.1.5")).toBe(true);
    expect(isTrustedIp("8.8.8.8")).toBe(false);
    expect(listTrustedNetworks()).toHaveLength(1);
    expect(removeTrustedNetwork(id)).toBe(true);
    expect(isTrustedIp("192.168.1.5")).toBe(false);
  });
});

describe("account lockout", () => {
  it("locks after the threshold of failures", () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) recordLoginAttempt("a@test.local", "9.9.9.9", false);
    expect(isAccountLocked("a@test.local")).toBe(false);
    recordLoginAttempt("a@test.local", "9.9.9.9", false);
    expect(isAccountLocked("a@test.local")).toBe(true);
  });

  it("matches the email case-insensitively", () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) recordLoginAttempt("A@Test.Local", "9.9.9.9", false);
    expect(isAccountLocked("a@test.local")).toBe(true);
  });

  it("clears the failures after a successful sign-in", () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) recordLoginAttempt("a@test.local", "9.9.9.9", false);
    expect(isAccountLocked("a@test.local")).toBe(true);
    recordLoginAttempt("a@test.local", "9.9.9.9", true);
    expect(isAccountLocked("a@test.local")).toBe(false);
  });

  it("ignores failures older than the window", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      db.prepare(
        "INSERT INTO login_attempts (id, email, ip_address, successful, created_at) VALUES (?, 'a@test.local', '9.9.9.9', 0, ?)"
      ).run(`old-${i}`, old);
    }
    expect(isAccountLocked("a@test.local")).toBe(false);
  });

  it("clearAccountLockout unlocks the account and reports how many it cleared", () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) recordLoginAttempt("locked@test.local", "9.9.9.9", false);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) recordLoginAttempt("other@test.local", "9.9.9.9", false);
    expect(isAccountLocked("locked@test.local")).toBe(true);

    // case-insensitive match; returns the number of failed attempts removed
    expect(clearAccountLockout("Locked@Test.Local")).toBe(LOCKOUT_THRESHOLD);
    expect(isAccountLocked("locked@test.local")).toBe(false);

    // other accounts are untouched
    expect(isAccountLocked("other@test.local")).toBe(true);
  });
});

describe("IP blocking", () => {
  it("blocks and unblocks manually", () => {
    expect(isIpBlocked("203.0.113.5")).toBe(false);
    blockIp("203.0.113.5", { reason: "abuse" });
    expect(isIpBlocked("203.0.113.5")).toBe(true);
    expect(listBlockedIps()).toHaveLength(1);
    expect(unblockIp("203.0.113.5")).toBe(true);
    expect(isIpBlocked("203.0.113.5")).toBe(false);
  });

  it("treats an expired block as not blocked", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    db.prepare("INSERT INTO blocked_ips (ip_address, reason, auto, expires_at) VALUES ('203.0.113.6', 'x', 1, ?)").run(past);
    expect(isIpBlocked("203.0.113.6")).toBe(false);
  });

  it("auto-blocks an IP past the failure threshold, exactly once", () => {
    for (let i = 0; i < IP_FAIL_THRESHOLD - 1; i += 1) recordLoginAttempt(`u${i}@test.local`, "203.0.113.7", false);
    expect(maybeAutoBlockIp("203.0.113.7")).toBe(false);
    recordLoginAttempt("u@test.local", "203.0.113.7", false);
    expect(maybeAutoBlockIp("203.0.113.7")).toBe(true);
    expect(isIpBlocked("203.0.113.7")).toBe(true);
    expect(maybeAutoBlockIp("203.0.113.7")).toBe(false);
  });
});

describe("configurable thresholds", () => {
  it("defaults when unset and round-trips through setSecurityPolicy", () => {
    expect(getSecurityPolicy()).toEqual(DEFAULT_SECURITY_POLICY);
    const custom = { ...DEFAULT_SECURITY_POLICY, lockoutThreshold: 2, lockoutMinutes: 10 };
    setSecurityPolicy(custom, null);
    expect(getSecurityPolicy()).toEqual(custom);
  });

  it("a lower lockout threshold takes effect immediately", () => {
    setSecurityPolicy({ ...DEFAULT_SECURITY_POLICY, lockoutThreshold: 2 }, null);
    recordLoginAttempt("a@test.local", "9.9.9.9", false);
    expect(isAccountLocked("a@test.local")).toBe(false);
    recordLoginAttempt("a@test.local", "9.9.9.9", false);
    expect(isAccountLocked("a@test.local")).toBe(true);
  });
});

describe("hasForwardedHeader", () => {
  it("detects proxy forwarding headers", () => {
    expect(hasForwardedHeader({ "x-forwarded-for": "1.2.3.4" })).toBe(true);
    expect(hasForwardedHeader({ forwarded: "for=1.2.3.4" })).toBe(true);
    expect(hasForwardedHeader({ "user-agent": "x" })).toBe(false);
    expect(hasForwardedHeader({})).toBe(false);
  });
});

describe("getTrustProxyHops", () => {
  const original = process.env.TRUST_PROXY_HOPS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = original;
  });

  it("is 0 when unset or invalid, the number when valid", () => {
    delete process.env.TRUST_PROXY_HOPS;
    expect(getTrustProxyHops()).toBe(0);
    process.env.TRUST_PROXY_HOPS = "1";
    expect(getTrustProxyHops()).toBe(1);
    process.env.TRUST_PROXY_HOPS = "abc";
    expect(getTrustProxyHops()).toBe(0);
  });
});
