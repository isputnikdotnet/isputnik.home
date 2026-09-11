// The double-submit CSRF check (core/csrf.ts), from the refusing side.
//
// Every state-changing request must carry, in the X-CSRF-Token header, the value
// of the token cookie the server handed out. A cross-site page can make the
// browser SEND our cookies but can neither read them nor set a custom header
// without a CORS preflight we don't grant — so a request with the header missing,
// wrong, or present only as the cookie is a forgery and gets a 403 before any
// route runs. There are no exemptions: the unauthenticated POSTs (sign-in, device
// linking, the public drop-link upload) sit inside the check too, which is what
// device-link-routes.ts documents and what the drop page relies on.
//
// With COOKIE_SECURE the cookie is __Host-isputnik_csrf, which a sibling subdomain
// cannot plant; a token under the old bare name must then count for nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { registerCsrf } from "../src/core/csrf.js";
import { authPlugin } from "../src/core/auth-routes.js";
import { deviceLinkRoutes } from "../src/core/device-link-routes.js";
import { galleryDropRoutesPlugin } from "../src/modules/library/gallery/drop-routes.js";
import { bootApp } from "./helpers/boot.js";
import { resetDb } from "./helpers/seed.js";

const COOKIE = "isputnik_csrf"; // the plain-http name; the suite runs with COOKIE_SECURE unset
const REFUSED = "Invalid or missing CSRF token. Reload the page and try again.";

let app: FastifyInstance;
let handled: string[];

async function buildApp(csrf: (instance: FastifyInstance) => void = registerCsrf): Promise<FastifyInstance> {
  // bootApp puts the hook on the root before any plugin, as index.ts does, so it
  // covers every route registered after it, however deeply nested.
  const { app: instance } = await bootApp({
    csrf,
    beforeRegister: (root) => {
      // HEAD comes free with GET (Fastify adds it), and runs the GET handler.
      for (const method of ["GET", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const) {
        root.route({
          method,
          url: "/api/thing",
          handler: async (request) => {
            handled.push(request.method);
            return { ok: true };
          }
        });
      }
    },
    plugins: [authPlugin, deviceLinkRoutes, galleryDropRoutesPlugin]
  });
  return instance;
}

function setCookies(res: LightMyRequestResponse): string[] {
  const raw = res.headers["set-cookie"];
  return raw == null ? [] : Array.isArray(raw) ? raw : [String(raw)];
}

/** The token a first GET hands out, the way the SPA picks it up on load. */
async function firstContact(name = COOKIE): Promise<string> {
  const res = await app.inject({ method: "GET", url: "/api/thing" });
  const entry = setCookies(res).find((line) => line.startsWith(`${name}=`));
  if (!entry) throw new Error(`no ${name} cookie was issued`);
  handled = []; // the GET itself isn't what the test is watching
  return entry.split(";")[0].slice(name.length + 1);
}

beforeEach(async () => {
  resetDb();
  handled = [];
  app = await buildApp();
});

afterEach(async () => {
  await app?.close();
});

describe("handing out the token", () => {
  it("issues a readable token cookie on first contact", async () => {
    const res = await app.inject({ method: "GET", url: "/api/thing" });

    expect(res.statusCode).toBe(200);
    const entry = setCookies(res).find((line) => line.startsWith(`${COOKIE}=`));
    expect(entry).toBeDefined();
    // The SPA must read it to echo it, so it can't be HttpOnly; Lax keeps it off
    // cross-site subrequests; Path=/ so every API path sees the same one.
    expect(entry).not.toMatch(/HttpOnly/i);
    expect(entry).toMatch(/SameSite=Lax/i);
    expect(entry).toMatch(/Path=\//);
    expect(entry!.split(";")[0].length).toBeGreaterThan(`${COOKIE}=`.length + 20);
  });

  it("keeps the token it already gave out", async () => {
    const res = await app.inject({ method: "GET", url: "/api/thing", cookies: { [COOKIE]: "existing-token" } });

    expect(setCookies(res).some((line) => line.startsWith(`${COOKIE}=`))).toBe(false);
  });

  it("gives every visitor a different token", async () => {
    expect(await firstContact()).not.toBe(await firstContact());
  });
});

describe("safe methods", () => {
  it.each(["GET", "HEAD", "OPTIONS"] as const)("lets %s through with no token at all", async (method) => {
    const res = await app.inject({ method, url: "/api/thing" });

    expect(res.statusCode).toBe(200);
    expect(handled).toEqual([method]);
  });
});

describe("state-changing methods", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("accepts %s when the header matches the cookie", async (method) => {
    const token = await firstContact();

    const res = await app.inject({
      method, url: "/api/thing", cookies: { [COOKIE]: token }, headers: { "x-csrf-token": token }
    });

    expect(res.statusCode).toBe(200);
    expect(handled).toContain(method);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("refuses %s with no token anywhere", async (method) => {
    const res = await app.inject({ method, url: "/api/thing" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: REFUSED });
    expect(handled).toEqual([]);
  });

  it("refuses the token when it is only in the cookie", async () => {
    // Exactly what a forged cross-site form looks like: the browser attaches the
    // cookie on its own, but nothing on the attacker's page can add the header.
    const token = await firstContact();

    const res = await app.inject({ method: "POST", url: "/api/thing", cookies: { [COOKIE]: token } });

    expect(res.statusCode).toBe(403);
    expect(handled).toEqual([]);
  });

  it("refuses a header that doesn't match the cookie", async () => {
    const token = await firstContact();

    const res = await app.inject({
      method: "POST", url: "/api/thing", cookies: { [COOKIE]: token }, headers: { "x-csrf-token": `${token}x` }
    });

    expect(res.statusCode).toBe(403);
    expect(handled).toEqual([]);
  });

  it("refuses a header with no cookie to match it against", async () => {
    // A guessed or stolen value is worthless without the cookie: the server mints
    // a fresh token for a cookieless request, and nobody knows that one yet.
    const res = await app.inject({ method: "POST", url: "/api/thing", headers: { "x-csrf-token": "guessed-token" } });

    expect(res.statusCode).toBe(403);
    expect(handled).toEqual([]);
  });

  it("refuses an empty token even when the cookie is empty too", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/thing", cookies: { [COOKIE]: "" }, headers: { "x-csrf-token": "" }
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a token passed some other way than the header", async () => {
    const token = await firstContact();

    const inQuery = await app.inject({
      method: "POST", url: `/api/thing?x-csrf-token=${token}&csrf=${token}`, cookies: { [COOKIE]: token }
    });
    const inBody = await app.inject({
      method: "POST", url: "/api/thing", cookies: { [COOKIE]: token }, payload: { csrf: token, "x-csrf-token": token }
    });

    expect(inQuery.statusCode).toBe(403);
    expect(inBody.statusCode).toBe(403);
  });
});

describe("no exemptions", () => {
  it.each([
    ["/api/auth/login", { email: "someone@test.local", password: "whatever" }, "signing in"],
    ["/api/auth/device/start", {}, "a device asking to be linked"],
    ["/api/drop/some-token/upload", {}, "the public drop-link upload"]
  ])("checks the unauthenticated POST %s (%s)", async (url, payload, _what) => {
    const bare = await app.inject({ method: "POST", url, payload });
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toEqual({ error: REFUSED });

    // And with the token, the route itself answers — so the 403 above was the
    // CSRF check and not the route's own refusal.
    const token = await firstContact();
    const withToken = await app.inject({
      method: "POST", url, payload, cookies: { [COOKIE]: token }, headers: { "x-csrf-token": token }
    });
    expect(withToken.json()).not.toEqual({ error: REFUSED });
  });
});

describe("with COOKIE_SECURE on", () => {
  const SECURE = "__Host-isputnik_csrf";
  let saved: string | undefined;

  beforeEach(async () => {
    await app.close();
    saved = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = "true";
    vi.resetModules();
    const fresh = await import("../src/core/csrf.js");
    app = await buildApp(fresh.registerCsrf);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = saved;
  });

  it("issues the token under the __Host- name, Secure", async () => {
    const res = await app.inject({ method: "GET", url: "/api/thing" });
    const entry = setCookies(res).find((line) => line.startsWith(`${SECURE}=`));

    expect(entry).toMatch(/;\s*Secure/i);
    expect(entry).toMatch(/Path=\//);
    expect(entry).not.toMatch(/Domain=/i);
  });

  it("accepts the __Host- token", async () => {
    const token = await firstContact(SECURE);

    const res = await app.inject({
      method: "POST", url: "/api/thing", cookies: { [SECURE]: token }, headers: { "x-csrf-token": token }
    });

    expect(res.statusCode).toBe(200);
  });

  it("gives a token under the old bare name no weight — the cookie-tossing case", async () => {
    // A neighbour on a shared parent domain can plant `isputnik_csrf=chosen` but
    // not a __Host- cookie. If the bare name still counted, the planted value plus
    // a matching header would pass.
    const res = await app.inject({
      method: "POST", url: "/api/thing", cookies: { [COOKIE]: "chosen" }, headers: { "x-csrf-token": "chosen" }
    });

    expect(res.statusCode).toBe(403);
    expect(handled).toEqual([]);
  });

  it("retires a token left under the old bare name", async () => {
    const res = await app.inject({ method: "GET", url: "/api/thing", cookies: { [COOKIE]: "stale" } });

    const cleared = setCookies(res).find((line) => line.startsWith(`${COOKIE}=`));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });
});
