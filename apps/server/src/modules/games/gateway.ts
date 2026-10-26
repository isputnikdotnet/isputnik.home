// The gateway to isputnik.games (docs/games-platform-plan.md → The contract).
//
// The shared gateway (modules/apps/gateway.ts) does what every container needs:
// the session check, the stripped and signed identity headers, the sign-in
// redirect, the 404 while the section is off. What is the games' own is here:
//
// A guest (docs → Guests) has no session: their browser carries the guest cookie
// a link set (guest-invites.ts), and the gateway forwards a guest identity scoped
// to the one match the link was for. A session cookie always takes precedence.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasSessionCookie } from "../../auth.js";
import { appDefinition } from "../apps/registry.js";
import { isPageNavigation as isAppPageNavigation, registerAppGateway } from "../apps/gateway.js";
import { noteGatewayResponse } from "./gateway-log.js";
import { GUEST_COOKIE, invalidLinkPage, pageLanguage, resolveGuestToken, touchGuest, guestIdentityHeaders, type GuestIdentity } from "./guest-invites.js";

// The shared pieces, under the names the games module and its tests have always used.
export { GATEWAY_HEADER, identityHeaders, signInHref, stripIdentityHeaders, type ForwardedRequest } from "../apps/gateway.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The guest a proxied request is from, when it is not from a member. */
    gamesGuest?: GuestIdentity;
  }
}

const GAMES = appDefinition("games");
export const GAMES_PREFIX = GAMES.prefix;

/** A browser opening a games PAGE rather than the games front end calling its API. */
export function isPageNavigation(request: FastifyRequest): boolean {
  return isAppPageNavigation(request, GAMES_PREFIX);
}

export interface GatewayOptions {
  /** The games server, e.g. http://isputnik-games:4200. */
  upstream: string;
  /** A function where the secret can change while the server runs (pairing). */
  secret: string | (() => string);
  /** Asked on every request: false while the admin has the Games section off,
   *  and the whole prefix answers 404 as if the games were not installed. */
  available?: () => boolean;
}

/** No session cookie but a guest cookie: the guest's link decides. A dead link
 *  gets, on a page navigation, the page that says so — the sign-in screen would
 *  be wrong for someone with no account — and a 401 on the API so the games
 *  front end can stop polling. The cookie is left in place: it expires with the
 *  link, a new link overwrites it, and while it lasts every page the guest opens
 *  explains itself instead of falling through to the sign-in screen. */
function admitGuest(request: FastifyRequest, reply: FastifyReply): "admit" | "answered" | "authenticate" {
  if (hasSessionCookie(request) || !request.cookies[GUEST_COOKIE]) return "authenticate";
  const guest = resolveGuestToken(request.cookies[GUEST_COOKIE]);
  if (guest) {
    request.gamesGuest = guest;
    touchGuest(guest.inviteId, request.ip);
    return "admit";
  }
  if (isPageNavigation(request)) {
    void reply.code(410).type("text/html; charset=utf-8").send(invalidLinkPage(pageLanguage(request.headers["accept-language"])));
  } else {
    void reply.code(401).send({ error: "This game link no longer works", guest: true });
  }
  return "answered";
}

export async function registerGamesGateway(app: FastifyInstance, options: GatewayOptions): Promise<void> {
  await registerAppGateway(app, {
    app: GAMES,
    upstream: options.upstream,
    secret: options.secret,
    available: options.available,
    hooks: {
      admitWithoutSession: admitGuest,
      identityFor: (request, secret, forwarded) => guestIdentityHeaders(request.gamesGuest!, secret, forwarded),
      // This app's own log of the games: who opened them, match decisions, and a
      // games container that refused our signature or did not answer (gateway-log.ts).
      onResponse: noteGatewayResponse
    }
  });
}
