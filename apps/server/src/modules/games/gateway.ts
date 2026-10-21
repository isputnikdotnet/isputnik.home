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
import type { FastifyInstance } from "fastify";
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

export interface GatewayOptions {
  /** The games server, e.g. http://isputnik-games:4200. */
  upstream: string;
  secret: string;
}

export async function registerGamesGateway(app: FastifyInstance, options: GatewayOptions): Promise<void> {
  await app.register(httpProxy, {
    upstream: options.upstream,
    prefix: GAMES_PREFIX,
    rewritePrefix: GAMES_PREFIX,
    // Only a signed-in member reaches the games; anonymous gets this app's 401.
    // The proxy's hook is callback-style, so the async decorator is adapted: once
    // authenticate has replied 401, Fastify sees the sent reply and never proxies.
    preHandler: (request, reply, done) => {
      app.authenticate(request, reply).then(() => done(), (err: Error) => done(err));
    },
    replyOptions: {
      rewriteRequestHeaders: (request, headers): IncomingHttpHeaders => ({
        ...stripIdentityHeaders(headers as IncomingHttpHeaders),
        ...identityHeaders(request.user!, options.secret)
      })
    }
  });
}
