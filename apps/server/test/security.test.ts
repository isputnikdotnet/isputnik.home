import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { makeUser, resetDb } from "./helpers/seed.js";
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
  getTrustProxyHops,
  noteSignInNetwork,
  seedKnownLoginNetworks
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

  // Rejected second factors are recorded as failed attempts (mfa-routes), and the
  // password step of an MFA sign-in deliberately records nothing — otherwise the
  // sequence below would reset the tally on every round and never lock.
  it("locks on rejected second factors alone", () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      // Each round: correct password (records nothing, MFA still pending) …
      recordLoginAttempt("mfa@test.local", "9.9.9.9", false); // … then a rejected code
    }
    expect(isAccountLocked("mfa@test.local")).toBe(true);
  });

  it("a completed second factor clears the tally, an abandoned one doesn't", () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) recordLoginAttempt("mfa@test.local", "9.9.9.9", false);
    expect(isAccountLocked("mfa@test.local")).toBe(false);

    // A completed sign-in records the success and wipes the slate.
    recordLoginAttempt("mfa@test.local", "9.9.9.9", true);
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) recordLoginAttempt("mfa@test.local", "9.9.9.9", false);
    expect(isAccountLocked("mfa@test.local")).toBe(false);

    recordLoginAttempt("mfa@test.local", "9.9.9.9", false);
    expect(isAccountLocked("mfa@test.local")).toBe(true);
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

describe("known sign-in networks", () => {
  it("reports the first sign-in from a network, then stops", () => {
    const user = makeUser("alice");
    expect(noteSignInNetwork(user, "203.0.113.10")).toEqual({ isNew: true, key: "203.0.113.0/24" });
    expect(noteSignInNetwork(user, "203.0.113.10")).toEqual({ isNew: false, key: "203.0.113.0/24" });
  });

  it("treats a nearby address as the same network but a different subnet as new", () => {
    const user = makeUser("alice");
    noteSignInNetwork(user, "203.0.113.10");
    // Same /24 — a rotating home or mobile address, not a new location.
    expect(noteSignInNetwork(user, "203.0.113.99")?.isNew).toBe(false);
    expect(noteSignInNetwork(user, "203.0.114.10")?.isNew).toBe(true);
  });

  it("matches IPv6 on the /64", () => {
    const user = makeUser("alice");
    expect(noteSignInNetwork(user, "2001:db8:1:2::1")?.isNew).toBe(true);
    expect(noteSignInNetwork(user, "2001:db8:1:2::99")?.isNew).toBe(false);
    expect(noteSignInNetwork(user, "2001:db8:1:3::1")?.isNew).toBe(true);
  });

  it("tracks each account separately", () => {
    const alice = makeUser("alice");
    const bob = makeUser("bob");
    noteSignInNetwork(alice, "203.0.113.10");
    expect(noteSignInNetwork(bob, "203.0.113.10")?.isNew).toBe(true);
  });

  it("ignores a missing IP", () => {
    const user = makeUser("alice");
    expect(noteSignInNetwork(user, null)).toBeNull();
  });

  it("seeds from existing sessions and successful sign-ins", () => {
    const user = makeUser("alice");
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at, ip_address) VALUES ('s1', 'h1', ?, '2099-01-01T00:00:00Z', '203.0.113.10')"
    ).run(user);
    recordLoginAttempt("alice@test.local", "198.51.100.7", true);
    recordLoginAttempt("alice@test.local", "198.51.100.8", false); // failures don't count

    expect(seedKnownLoginNetworks()).toBe(2);
    expect(noteSignInNetwork(user, "203.0.113.55")?.isNew).toBe(false);
    expect(noteSignInNetwork(user, "198.51.100.20")?.isNew).toBe(false);
    // The failed attempt's network is a different /24 and stays unknown.
    expect(noteSignInNetwork(user, "198.51.101.8")?.isNew).toBe(true);
  });

  it("seeding twice adds nothing the second time", () => {
    const user = makeUser("alice");
    db.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, expires_at, ip_address) VALUES ('s1', 'h1', ?, '2099-01-01T00:00:00Z', '203.0.113.10')"
    ).run(user);
    expect(seedKnownLoginNetworks()).toBe(1);
    expect(seedKnownLoginNetworks()).toBe(0);
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
