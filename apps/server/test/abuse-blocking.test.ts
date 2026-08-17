import { beforeEach, describe, expect, it, vi } from "vitest";

// Crossing the block threshold sends an admin alert; keep it off the wire.
vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}) };
});

import type { FastifyRequest } from "fastify";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { isProbePath } from "../src/core/probes.js";
import { flagAbusiveRequest } from "../src/core/security-alerts.js";
import {
  addTrustedNetwork,
  isAccountLocked,
  isIpBlocked,
  recordAbuseAttempt,
  recordLoginAttempt,
  DEFAULT_SECURITY_POLICY
} from "../src/core/security.js";
import { resolveShareLink } from "../src/modules/library/shared/share-access.js";
import { resolveLiveInvite } from "../src/modules/users/invites.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const IP_FAIL_THRESHOLD = DEFAULT_SECURITY_POLICY.ipFailThreshold;

// flagAbusiveRequest only reads .ip and the marker it sets, so a stub is enough.
function fakeRequest(ip: string): FastifyRequest {
  return { ip } as FastifyRequest;
}

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
});

describe("isProbePath", () => {
  it("matches scanner sweeps for software this app doesn't run", () => {
    for (const url of [
      "/wp-login.php",
      "/wp-admin/setup-config.php",
      "/.env",
      "/.env.local",
      "/.git/config",
      "/.ssh/id_rsa",
      "/phpmyadmin/index.php",
      "/cgi-bin/test.cgi",
      "/vendor/phpunit/phpunit/phpunit.xml",
      "/actuator/health",
      "/backup.sql",
      "/index.php?s=/admin"
    ]) {
      expect(isProbePath(url), url).toBe(true);
    }
  });

  it("leaves everything the app actually serves alone", () => {
    for (const url of [
      "/",
      "/index.html",
      "/control/security",
      "/gallery/timeline?view=folder",
      "/static/index-a1b2c3.js",
      "/Assets/brand/logo.svg",
      "/manifest.webmanifest",
      "/sw.js",
      "/favicon.ico",
      "/robots.txt",
      // ACME renewal and app-association files live here — never a probe.
      "/.well-known/acme-challenge/tokenvalue",
      "/api/library/covers/abc/def.jpg",
      "/api/share/sometoken/download-all",
      "/opds/isp_opds_abc123/new"
    ]) {
      expect(isProbePath(url), url).toBe(false);
    }
  });
});

describe("flagAbusiveRequest", () => {
  it("counts a hit once per request, however many times it's called", () => {
    const request = fakeRequest("203.0.113.5");
    flagAbusiveRequest(request, "probe");
    flagAbusiveRequest(request, "probe");
    flagAbusiveRequest(request, "token");
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE ip_address = ?")
      .get("203.0.113.5") as { count: number };
    expect(row.count).toBe(1);
  });

  it("blocks the source once it crosses the failure threshold", () => {
    for (let i = 0; i < IP_FAIL_THRESHOLD - 1; i += 1) flagAbusiveRequest(fakeRequest("203.0.113.6"), "probe");
    expect(isIpBlocked("203.0.113.6")).toBe(false);
    flagAbusiveRequest(fakeRequest("203.0.113.6"), "probe");
    expect(isIpBlocked("203.0.113.6")).toBe(true);
  });

  it("never counts or blocks a trusted network", () => {
    addTrustedNetwork("192.168.0.0/16", "Home LAN", null);
    for (let i = 0; i < IP_FAIL_THRESHOLD + 5; i += 1) flagAbusiveRequest(fakeRequest("192.168.1.10"), "probe");
    expect(isIpBlocked("192.168.1.10")).toBe(false);
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE ip_address = ?")
      .get("192.168.1.10") as { count: number };
    expect(row.count).toBe(0);
  });

  it("can never help lock a real account", () => {
    // Anonymous hits carry no email, so they sit outside every account's tally.
    for (let i = 0; i < 50; i += 1) recordAbuseAttempt("203.0.113.7", "token");
    expect(isAccountLocked("someone@test.local")).toBe(false);

    // …while a real failed sign-in from the same address still counts normally.
    for (let i = 0; i < DEFAULT_SECURITY_POLICY.lockoutThreshold; i += 1) {
      recordLoginAttempt("someone@test.local", "203.0.113.7", false);
    }
    expect(isAccountLocked("someone@test.local")).toBe(true);
  });
});

describe("share token misses", () => {
  function seedLink(token: string, opts: { expiresAt?: string; revoked?: boolean } = {}): void {
    const owner = makeUser("owner");
    db.prepare(
      `INSERT INTO share_links (id, module, resource_id, token_hash, permission, expires_at, created_by, revoked_at)
       VALUES ('link1', 'gallery', 'item1', ?, 'read', ?, ?, ?)`
    ).run(
      sha256(token),
      opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      owner,
      opts.revoked ? new Date().toISOString() : null
    );
  }

  function hitCount(ip: string): number {
    return (
      db.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE ip_address = ?").get(ip) as { count: number }
    ).count;
  }

  it("counts a token that matches nothing at all", () => {
    const request = fakeRequest("203.0.113.20");
    expect(resolveShareLink("totally-made-up", request)).toBeNull();
    expect(hitCount("203.0.113.20")).toBe(1);
  });

  it("does not count the family's own expired or revoked link", () => {
    seedLink("stale", { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const request = fakeRequest("203.0.113.21");
    expect(resolveShareLink("stale", request)).toBeNull();
    expect(hitCount("203.0.113.21")).toBe(0);

    db.prepare("UPDATE share_links SET expires_at = ?, revoked_at = ? WHERE id = 'link1'").run(
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString()
    );
    expect(resolveShareLink("stale", fakeRequest("203.0.113.22"))).toBeNull();
    expect(hitCount("203.0.113.22")).toBe(0);
  });

  it("resolves a live link and counts nothing", () => {
    seedLink("good");
    const request = fakeRequest("203.0.113.23");
    expect(resolveShareLink("good", request)?.id).toBe("link1");
    expect(hitCount("203.0.113.23")).toBe(0);
  });
});

describe("invite token misses", () => {
  // resetDb doesn't clear invites, so each seed gets its own id and token.
  function seedInvite(token: string, opts: { expired?: boolean; revoked?: boolean; used?: boolean } = {}): string {
    const admin = makeUser("inviter");
    const id = `inv-${token}`;
    db.prepare(
      `INSERT INTO invites (id, token_hash, role, created_by, expires_at, used_at, revoked_at)
       VALUES (?, ?, 'member', ?, ?, ?, ?)`
    ).run(
      id,
      sha256(token),
      admin,
      opts.expired ? new Date(Date.now() - 1000).toISOString() : new Date(Date.now() + 86_400_000).toISOString(),
      opts.used ? new Date().toISOString() : null,
      opts.revoked ? new Date().toISOString() : null
    );
    return id;
  }

  function hitCount(ip: string): number {
    return (
      db.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE ip_address = ?").get(ip) as { count: number }
    ).count;
  }

  it("counts a token that matches nothing at all", () => {
    const request = fakeRequest("203.0.113.30");
    expect(resolveLiveInvite("totally-made-up", request)).toBeNull();
    expect(hitCount("203.0.113.30")).toBe(1);
  });

  it("does not count a stale link a family member legitimately held", () => {
    const id = seedInvite("stale", { expired: true });
    expect(resolveLiveInvite("stale", fakeRequest("203.0.113.31"))).toBeNull();
    expect(hitCount("203.0.113.31")).toBe(0);

    db.prepare("UPDATE invites SET expires_at = ?, revoked_at = ? WHERE id = ?").run(
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString(),
      id
    );
    expect(resolveLiveInvite("stale", fakeRequest("203.0.113.32"))).toBeNull();
    expect(hitCount("203.0.113.32")).toBe(0);

    db.prepare("UPDATE invites SET revoked_at = NULL, used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    expect(resolveLiveInvite("stale", fakeRequest("203.0.113.33"))).toBeNull();
    expect(hitCount("203.0.113.33")).toBe(0);
  });

  it("resolves a live invite and counts nothing", () => {
    const id = seedInvite("good");
    const request = fakeRequest("203.0.113.34");
    expect(resolveLiveInvite("good", request)?.id).toBe(id);
    expect(hitCount("203.0.113.34")).toBe(0);
  });
});
