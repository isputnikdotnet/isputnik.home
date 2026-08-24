import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { resetDb } from "./helpers/seed.js";
import {
  addTrustedNetwork,
  getTrustProxyCidrs,
  isProxyTrustConfigured,
  isTrustedRequest,
  parseTrustProxyList,
  resolveProxyTrust
} from "../src/core/security.js";

// How X-Forwarded-For becomes request.ip under the two proxy-trust settings.
// TRUST_PROXY (the proxy's own addresses) is the strong form: the header is
// believed only while the peer that sent it is on the list, so a client that
// reaches the app directly can forge nothing. TRUST_PROXY_HOPS keeps the old
// numeric semantics — trust the first N hops whoever they are — and therefore
// still depends on the app being unreachable except through the proxy.

const PROXY = "172.18.0.2"; // the reverse proxy's own (Docker-network) address
const CLIENT = "203.0.113.9"; // the visitor the proxy forwards for
const ATTACKER = "198.51.100.7"; // reaches the app directly and forges a header

function clearEnv() {
  delete process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY_HOPS;
}

beforeEach(clearEnv);
afterEach(clearEnv);

/** A throwaway app wired exactly like index.ts: trustProxy from resolveProxyTrust. */
async function appWithTrust(): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: resolveProxyTrust() });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}

/** What request.ip resolves to for a connection from `remoteAddress` carrying `xff`. */
async function seenIp(app: FastifyInstance, remoteAddress: string, xff?: string): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: "/ip",
    remoteAddress,
    headers: xff ? { "x-forwarded-for": xff } : {}
  });
  return (res.json() as { ip: string }).ip;
}

describe("with neither setting configured", () => {
  it("ignores X-Forwarded-For and reports the socket address", async () => {
    const app = await appWithTrust();
    expect(await seenIp(app, PROXY, CLIENT)).toBe(PROXY);
    expect(await seenIp(app, PROXY)).toBe(PROXY);
    await app.close();
  });
});

describe("TRUST_PROXY_HOPS (hop-count trust, backward compatible)", () => {
  it("reads the client past one trusted hop", async () => {
    process.env.TRUST_PROXY_HOPS = "1";
    const app = await appWithTrust();
    expect(await seenIp(app, PROXY, CLIENT)).toBe(CLIENT);
    await app.close();
  });

  it("walks exactly as many hops as configured", async () => {
    process.env.TRUST_PROXY_HOPS = "1";
    const one = await appWithTrust();
    // Two proxies in the chain but only one hop trusted: the inner proxy's
    // address is as far as the walk goes.
    expect(await seenIp(one, PROXY, `${CLIENT}, 10.0.0.5`)).toBe("10.0.0.5");
    await one.close();

    process.env.TRUST_PROXY_HOPS = "2";
    const two = await appWithTrust();
    expect(await seenIp(two, PROXY, `${CLIENT}, 10.0.0.5`)).toBe(CLIENT);
    await two.close();
  });

  it("cannot validate the immediate peer — a direct client's forged header is believed", async () => {
    // The documented weakness of the hop form, and why the address form exists:
    // with hops set, the app must not be reachable except through the proxy.
    process.env.TRUST_PROXY_HOPS = "1";
    const app = await appWithTrust();
    expect(await seenIp(app, ATTACKER, "1.2.3.4")).toBe("1.2.3.4");
    await app.close();
  });
});

describe("TRUST_PROXY (address trust)", () => {
  it("reads the client past a peer on the list", async () => {
    process.env.TRUST_PROXY = "172.18.0.0/16";
    const app = await appWithTrust();
    expect(await seenIp(app, PROXY, CLIENT)).toBe(CLIENT);
    await app.close();
  });

  it("accepts a bare address as a single-host range", async () => {
    process.env.TRUST_PROXY = PROXY;
    const app = await appWithTrust();
    expect(await seenIp(app, PROXY, CLIENT)).toBe(CLIENT);
    expect(await seenIp(app, "172.18.0.3", CLIENT)).toBe("172.18.0.3");
    await app.close();
  });

  it("ignores a forged header from a peer that is not on the list", async () => {
    // The property the hop form cannot offer: a directly-reachable app still
    // refuses spoofed X-Forwarded-For, because the attacker's own address is
    // what gets checked.
    process.env.TRUST_PROXY = "172.18.0.0/16";
    const app = await appWithTrust();
    expect(await seenIp(app, ATTACKER, "1.2.3.4")).toBe(ATTACKER);
    await app.close();
  });

  it("walks a chain while every hop is on the list, and stops at the first that isn't", async () => {
    process.env.TRUST_PROXY = "172.18.0.0/16, 10.0.0.5";
    const chained = await appWithTrust();
    // CDN (10.0.0.5) → proxy (socket) chain: both trusted, so the client shows.
    expect(await seenIp(chained, PROXY, `${CLIENT}, 10.0.0.5`)).toBe(CLIENT);
    // An untrusted middle hop ends the walk there.
    expect(await seenIp(chained, PROXY, `${CLIENT}, 192.0.2.77`)).toBe("192.0.2.77");
    await chained.close();
  });

  it("matches an IPv4 peer reported as an IPv6-mapped address", async () => {
    // A dual-stack socket reports ::ffff:172.18.0.2; cidr.ts resolves the
    // mapped form back to IPv4, so a v4 range still matches it.
    process.env.TRUST_PROXY = "172.18.0.0/16";
    const app = await appWithTrust();
    expect(await seenIp(app, "::ffff:172.18.0.2", CLIENT)).toBe(CLIENT);
    await app.close();
  });

  it("wins over TRUST_PROXY_HOPS when both are set", async () => {
    process.env.TRUST_PROXY = "10.99.0.1"; // not the socket's address
    process.env.TRUST_PROXY_HOPS = "5";
    const app = await appWithTrust();
    // Were the hop count in effect, the header would be believed; the address
    // form is stricter and the socket peer isn't on the list, so it is not.
    expect(await seenIp(app, PROXY, CLIENT)).toBe(PROXY);
    await app.close();
  });
});

describe("parsing TRUST_PROXY", () => {
  it("splits on commas, trims, and drops entries that don't parse", () => {
    process.env.TRUST_PROXY = " 172.18.0.0/16 ,not-an-ip, 10.0.0.5/40 ,, 10.0.0.5 ";
    expect(parseTrustProxyList()).toEqual({
      cidrs: ["172.18.0.0/16", "10.0.0.5"],
      invalid: ["not-an-ip", "10.0.0.5/40"]
    });
    expect(getTrustProxyCidrs()).toEqual(["172.18.0.0/16", "10.0.0.5"]);
  });

  it("is empty when unset or blank", () => {
    expect(parseTrustProxyList()).toEqual({ cidrs: [], invalid: [] });
    process.env.TRUST_PROXY = "   ";
    expect(parseTrustProxyList()).toEqual({ cidrs: [], invalid: [] });
  });
});

describe("isProxyTrustConfigured", () => {
  it("answers for either setting, and not for an all-invalid TRUST_PROXY", () => {
    expect(isProxyTrustConfigured()).toBe(false);
    process.env.TRUST_PROXY_HOPS = "1";
    expect(isProxyTrustConfigured()).toBe(true);
    clearEnv();
    process.env.TRUST_PROXY = "172.18.0.0/16";
    expect(isProxyTrustConfigured()).toBe(true);
    process.env.TRUST_PROXY = "not-an-ip";
    // Nothing usable on the list: same as unset, so the fail-closed checks
    // (trusted zones, outside-MFA, device linking) stay closed.
    expect(isProxyTrustConfigured()).toBe(false);
    expect(resolveProxyTrust()).toBe(false);
  });
});

describe("fail-closed checks honour the address form", () => {
  beforeEach(() => {
    resetDb();
    db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  });

  it("isTrustedRequest believes a forwarded request once TRUST_PROXY is set", () => {
    addTrustedNetwork("203.0.113.0/24", "test range", null);
    const request = { ip: CLIENT, headers: { "x-forwarded-for": CLIENT } };
    // Unconfigured: the address can't be believed, so the match is refused.
    expect(isTrustedRequest(request)).toBe(false);
    // With address trust configured, request.ip is real and the match stands.
    process.env.TRUST_PROXY = "172.18.0.0/16";
    expect(isTrustedRequest(request)).toBe(true);
  });
});
