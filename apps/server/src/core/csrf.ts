import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { config } from "../config.js";

// Double-submit CSRF protection. A JS-readable token cookie is issued on first
// contact; the SPA echoes it in the X-CSRF-Token header on every state-changing
// request, and we reject the request unless the header matches the cookie. A
// cross-site page can neither read our cookie (same-origin) nor set a custom
// header on a cross-origin request (CORS preflight), so it can't forge a match.
// Layers on top of the SameSite=Lax session cookie and the locked-down CORS origin.
const LEGACY_CSRF_COOKIE = "isputnik_csrf";
// The __Host- prefix pins a cookie to this exact origin: a browser only accepts it
// with Secure, Path=/ and no Domain, and refuses to let a sibling subdomain
// overwrite it. That closes cookie-tossing — a neighbour on a shared parent domain
// planting a token of their choosing to make a forged request's header match.
// The prefix REQUIRES Secure, so a plain-http LAN deployment (COOKIE_SECURE off)
// has to keep the bare name; naming it __Host- there would have the browser drop
// the cookie outright and 403 every mutation.
export function csrfCookieName(secure: boolean): string {
  return secure ? `__Host-${LEGACY_CSRF_COOKIE}` : LEGACY_CSRF_COOKIE;
}
const CSRF_COOKIE = csrfCookieName(config.cookieSecure);
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function registerCsrf(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    // Issue the token on first contact (and re-issue if missing). Not httpOnly —
    // the SPA must read it to echo it back. A safe GET (index.html, the startup
    // /api/auth/me) establishes it before any mutation is attempted.
    let token = request.cookies[CSRF_COOKIE];
    if (!token) {
      token = nanoid(32);
      reply.setCookie(CSRF_COOKIE, token, {
        httpOnly: false,
        secure: config.cookieSecure,
        sameSite: "lax",
        path: "/"
      });
    }
    // Retire a token left under the old bare name by a pre-__Host- version, so the
    // browser can't hold two and the SPA can't pick the stale one.
    if (CSRF_COOKIE !== LEGACY_CSRF_COOKIE && request.cookies[LEGACY_CSRF_COOKIE]) {
      reply.clearCookie(LEGACY_CSRF_COOKIE, { path: "/" });
    }

    if (SAFE_METHODS.has(request.method)) return;

    const header = request.headers[CSRF_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || provided !== token) {
      reply.code(403).send({ error: "Invalid or missing CSRF token. Reload the page and try again." });
    }
  });
}
