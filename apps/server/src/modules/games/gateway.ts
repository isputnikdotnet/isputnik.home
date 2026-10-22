// The gateway to isputnik.games (docs/games-platform-plan.md → The contract).
//
// The games run in a container of their own that never faces the network. This
// server proxies everything under /games to it and, on each request, says who is
// asking: the session is validated here exactly as for any route (authenticate —
// so MFA, trusted networks, rate limits, blocks and "preview as member" all
// apply), then the member's identity rides along in X-Isputnik-* headers signed
// with a shared secret. Any X-Isputnik-* header the client itself sent is dropped
// first, so nobody can pose as this gateway from outside.
//
// CSRF: the double-submit hook on the root runs for proxied requests too, so the
// games front end echoes this app's CSRF cookie on its own state-changing calls.
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import httpProxy from "@fastify/http-proxy";
import type { User } from "../../db.js";

export const GAMES_PREFIX = "/games";

export const GATEWAY_HEADER = "x-isputnik-gateway";
const IDENTITY_PREFIX = "x-isputnik-";

/** The headers that tell the games server who is signed in. The display name is
 *  percent-encoded: header values are Latin-1 and the family's names are not. */
export function identityHeaders(user: User, secret: string): Record<string, string> {
  return {
    [GATEWAY_HEADER]: secret,
    "x-isputnik-user-id": user.id,
    "x-isputnik-user-name": encodeURIComponent(user.display_name),
    "x-isputnik-user-role": user.role,
    "x-isputnik-user-lang": user.language,
    "x-isputnik-user-theme": user.theme
  };
}

/** Every header except the ones only this gateway may set. */
export function stripIdentityHeaders<T extends Record<string, unknown>>(headers: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(headers) as (keyof T)[]) {
    if (String(key).toLowerCase().startsWith(IDENTITY_PREFIX)) continue;
    out[key] = headers[key];
  }
  return out;
}

/** A browser opening a games PAGE (a bookmark, the installed app's icon) rather
 *  than the games front end calling its API. The API keeps the 401 so the front
 *  end can say "signed out"; a page gets the sign-in screen and comes back. */
export function isPageNavigation(request: FastifyRequest): boolean {
  if (request.method !== "GET") return false;
  if (request.url.startsWith(`${GAMES_PREFIX}/api/`)) return false;
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html");
}

/** Where to send a signed-out page navigation: the sign-in screen, which brings
 *  them back here afterwards (LoginPage reads `next`). Only the path, so the
 *  value can never point off this origin. */
export function signInHref(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

export interface GatewayOptions {
  /** The games server, e.g. http://isputnik-games:4200. */
  upstream: string;
  secret: string;
  /** Asked on every request: false while the admin has the Games section off,
   *  and the whole prefix answers 404 as if the games were not installed. */
  available?: () => boolean;
}

export async function registerGamesGateway(app: FastifyInstance, options: GatewayOptions): Promise<void> {
  // Its own scope, so the hook below sees only what goes through the proxy.
  await app.register(async (scope) => {
    // authenticate has already written its 401 by the time it returns, so the
    // redirect for a page navigation is applied as the reply leaves: a signed-out
    // person opening /games/ from a bookmark or the installed app lands on the
    // sign-in screen instead of a line of JSON. API calls keep the 401.
    scope.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode !== 401 || !isPageNavigation(request)) return payload;
      reply.code(302).header("location", signInHref(request.url)).removeHeader("content-type");
      return "";
    });

    await scope.register(httpProxy, {
      upstream: options.upstream,
      prefix: GAMES_PREFIX,
      rewritePrefix: GAMES_PREFIX,
      // Only a signed-in member reaches the games; anonymous gets this app's 401.
      // The proxy's hook is callback-style, so the async decorator is adapted: once
      // authenticate has replied 401, Fastify sees the sent reply and never proxies.
      preHandler: (request, reply, done) => {
        // Answered from the hook: no done() after a send (Fastify stops here).
        if (options.available && !options.available()) {
          void reply.code(404).send({ error: "Not found" });
          return;
        }
        app.authenticate(request, reply).then(() => done(), (err: Error) => done(err));
      },
      replyOptions: {
        rewriteRequestHeaders: (request, headers): IncomingHttpHeaders => ({
          ...stripIdentityHeaders(headers as IncomingHttpHeaders),
          ...identityHeaders(request.user!, options.secret)
        })
      }
    });
  });
}
