// Games — the way into isputnik.games, a project and container of its own that
// uses this server for sign-in (docs/games-platform-plan.md). A product module:
// it knows there are games and where they live. The gateway itself is gateway.ts;
// guest links (a member inviting someone with no account) are guest-invites.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { hasSessionCookie } from "../../auth.js";
import { getSections } from "../../core/sections.js";
import { flagAbusiveRequest } from "../../core/security-alerts.js";
import { parseBody } from "../../core/shared.js";
import { GAMES_PREFIX, identityHeaders, registerGamesGateway } from "./gateway.js";
import {
  GUEST_COOKIE,
  GUEST_LINK_PATH,
  bindGuestInvite,
  discardGuestInvite,
  getGuestInvite,
  guestLinkUrl,
  guestTokenKnown,
  invalidLinkPage,
  listGuestInvites,
  logGuestInviteEvent,
  mintGuestInvite,
  normalizeGuestName,
  noteGuestOpened,
  pageLanguage,
  renewGuestInvite,
  resolveGuestToken,
  revokeGuestInvite
} from "./guest-invites.js";

/** Whether the games server answers, for the Control panel's Games tab. A short
 *  timeout: the page is drawn around this answer, and a container that is down
 *  should say so in a moment, not a minute. */
async function probeGamesServer(upstream: string): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  try {
    const response = await fetch(`${upstream}/games/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { ok: false, version: null, error: `HTTP ${response.status}` };
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; version?: string };
    return { ok: body.ok === true, version: body.version ?? null, error: body.ok === true ? null : "Unexpected answer" };
  } catch (err) {
    return { ok: false, version: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether the games server takes this app's signature: one signed call as the
 *  admin asking. Health alone answers the same with any secret, so a mismatch
 *  looked "on" here while every member got "Not signed in". null = not known
 *  (the call itself failed — the health probe says why). */
async function probeSecret(upstream: string, secret: string, request: FastifyRequest): Promise<boolean | null> {
  try {
    const response = await fetch(`${upstream}${GAMES_PREFIX}/api/me`, {
      headers: identityHeaders(request.user!, secret, { ip: request.ip, requestId: String(request.id) }),
      signal: AbortSignal.timeout(4000)
    });
    if (response.status === 401) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

export function gamesConfigured(upstream = config.gamesUrl, secret = config.gamesGatewaySecret): { enabled: boolean; reason?: string } {
  if (!upstream) return { enabled: false };
  if (!secret) return { enabled: false, reason: "GAMES_URL is set but GAMES_GATEWAY_SECRET is not; the games stay off until both are set." };
  if (!/^https?:\/\//.test(upstream)) return { enabled: false, reason: `GAMES_URL must start with http:// or https:// (got "${upstream}"); the games stay off.` };
  return { enabled: true };
}

const guestInviteSchema = z.object({
  game: z.string().trim().min(1).max(32),
  options: z.unknown(),
  seat: z.union([z.literal(0), z.literal(1)]).default(0),
  guestName: z.string().transform(normalizeGuestName).pipe(z.string().min(1).max(60))
});

const guestListQuerySchema = z.object({
  match: z.string().trim().max(64).optional(),
  all: z.string().optional()
});

/** Minting and opening are the two routes a stranger can reach or that cost a
 *  games call; a household never needs more than a few a minute. */
const GUEST_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: "1 minute" } };

/** How a games-side answer comes back to the member who asked: its own 4xx with
 *  its own message, and a 502 for anything that is the container's problem. */
function forwardedStatus(status: number): number {
  return status >= 400 && status < 500 ? status : 502;
}

export interface GamesPluginOptions {
  /** Overrides for tests, which run without GAMES_URL and point at a stand-in. */
  upstream?: string;
  secret?: string;
}

export async function gamesPlugin(app: FastifyInstance, opts: GamesPluginOptions = {}) {
  const upstream = opts.upstream ?? config.gamesUrl;
  const secret = opts.secret ?? config.gamesGatewaySecret;
  const status = gamesConfigured(upstream, secret);
  if (status.reason) app.log.warn(status.reason);
  // Switched off by the admin = not there, for the gateway and the guest routes alike.
  const available = () => status.enabled && getSections().games;

  // The web app asks this once to decide whether to show the Games entry: the
  // gateway configured AND the admin's Games section on (core/sections.ts).
  app.get("/api/games/status", { preHandler: app.authenticate }, async () => ({ enabled: available() }));

  // Who can be invited to a match: the active members, by name. The games app
  // calls this on the home origin itself (same session cookie), so the games
  // server never needs to reach back here — the one read the contract allows
  // (docs/games-platform-plan.md → Members list).
  app.get("/api/games/members", { preHandler: app.authenticate }, async () => {
    const rows = db.prepare(
      "SELECT id, display_name FROM users WHERE deleted_at IS NULL AND is_active = 1 ORDER BY display_name COLLATE NOCASE"
    ).all() as { id: string; display_name: string }[];
    return { members: rows.map((row) => ({ id: row.id, name: row.display_name })) };
  });

  // Control panel → Settings → Games: how the integration stands. Read-only on
  // purpose — the two settings are environment variables (the owner's decision:
  // the panel shows them, the container's configuration sets them). The secret
  // itself never leaves the server; only whether one is set.
  app.get("/api/games/admin/status", { preHandler: app.requireAdmin }, async (request) => {
    const server = status.enabled ? await probeGamesServer(upstream) : null;
    return {
      configured: status.enabled,
      reason: status.reason ?? null,
      url: upstream || null,
      secretSet: Boolean(secret),
      // Asked only of a server that answers: true / false (the two secrets differ) / null.
      secretAccepted: server?.ok ? await probeSecret(upstream, secret, request) : null,
      server
    };
  });

  // ── Guest links (docs/games-platform-plan.md → Guests) ───────────────────

  const notAvailable = (reply: FastifyReply) => reply.code(404).send({ error: "The games are not available" });
  /** The link's owner, or an admin: the two who may renew or revoke it. */
  const mayManage = (request: FastifyRequest, createdBy: string) => request.user!.role === "admin" || request.user!.id === createdBy;

  // A member invites someone with no account: one call mints the link's row,
  // creates the match on the games server in the member's own name (the same
  // signed headers the gateway would add — home → games is the contract's trust
  // direction), binds the two, and hands the link back. Shown once: only its
  // hash is kept.
  app.post("/api/games/guest-invites", { preHandler: app.authenticate, config: GUEST_RATE_LIMIT }, async (request, reply) => {
    if (!available()) return notAvailable(reply);
    const parsed = parseBody(guestInviteSchema, request.body);
    if ("error" in parsed) return reply.code(400).send(parsed.error);
    const input = parsed.data;
    const me = request.user!;
    const minted = mintGuestInvite({ userId: me.id, guestName: input.guestName, game: input.game });

    let created: { status: number; body: Record<string, unknown> };
    try {
      const response = await fetch(`${upstream}${GAMES_PREFIX}/api/matches`, {
        method: "POST",
        headers: { "content-type": "application/json", ...identityHeaders(me, secret, { ip: request.ip, requestId: String(request.id) }) },
        body: JSON.stringify({ game: input.game, options: input.options ?? {}, seat: input.seat, opponent: { id: minted.guestId, name: input.guestName } }),
        signal: AbortSignal.timeout(8000)
      });
      created = { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    } catch (err) {
      discardGuestInvite(minted.id);
      request.log.warn({ err }, "Games server did not answer while creating a guest match");
      return reply.code(502).send({ error: "The games server did not answer" });
    }
    if (created.status < 200 || created.status >= 300 || typeof created.body.id !== "string") {
      discardGuestInvite(minted.id);
      const message = typeof created.body.error === "string" ? created.body.error : `The games server answered ${created.status}`;
      return reply.code(forwardedStatus(created.status)).send({ error: message });
    }
    bindGuestInvite(minted.id, created.body.id);
    logGuestInviteEvent("created", { id: minted.id, guestName: input.guestName, game: input.game }, me, request.ip);
    return reply.code(201).send({ invite: getGuestInvite(minted.id), url: guestLinkUrl(minted.token), match: created.body });
  });

  // The member's own links (an admin may ask for everyone's with ?all=1),
  // optionally those of one match: state, how often opened, from where.
  app.get("/api/games/guest-invites", { preHandler: app.authenticate }, async (request, reply) => {
    const query = guestListQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "Invalid query" });
    const everyone = query.data.all !== undefined && request.user!.role === "admin";
    return { invites: listGuestInvites({ userId: everyone ? undefined : request.user!.id, matchId: query.data.match || undefined }) };
  });

  // A new link for the same guest and match: the old one stops working at once.
  app.post("/api/games/guest-invites/:id/renew", { preHandler: app.authenticate, config: GUEST_RATE_LIMIT }, async (request, reply) => {
    const invite = getGuestInvite((request.params as { id: string }).id);
    if (!invite || !mayManage(request, invite.createdBy.id)) return reply.code(404).send({ error: "No such guest link" });
    const renewed = renewGuestInvite(invite.id);
    if (!renewed) return reply.code(409).send({ error: "This guest link cannot be renewed" });
    logGuestInviteEvent("renewed", invite, request.user!, request.ip);
    return { invite: getGuestInvite(invite.id), url: guestLinkUrl(renewed.token) };
  });

  app.delete("/api/games/guest-invites/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const invite = getGuestInvite((request.params as { id: string }).id);
    if (!invite || !mayManage(request, invite.createdBy.id)) return reply.code(404).send({ error: "No such guest link" });
    if (revokeGuestInvite(invite.id, request.user!.id)) logGuestInviteEvent("revoked", invite, request.user!, request.ip);
    return { invite: getGuestInvite(invite.id) };
  });

  // The link itself. A good one sets the guest cookie and sends the browser to
  // the match; a dead one (expired, revoked) gets the page saying so; a token
  // that matches nothing is a guess and counts against its source address, the
  // way an unknown share link does. A browser that already holds a session is
  // sent to the match as the member it is — the cookie is never set over one.
  app.get(`${GUEST_LINK_PATH}/:token`, { config: GUEST_RATE_LIMIT }, async (request, reply) => {
    if (!available()) return notAvailable(reply);
    const token = (request.params as { token: string }).token;
    const page = (request.headers.accept ?? "").includes("text/html");
    const guest = resolveGuestToken(token);
    if (!guest) {
      const known = guestTokenKnown(token);
      if (!known) flagAbusiveRequest(request, "token");
      if (page) return reply.code(known ? 410 : 404).type("text/html; charset=utf-8").send(invalidLinkPage(pageLanguage(request.headers["accept-language"])));
      return reply.code(known ? 410 : 404).send({ error: "This game link no longer works" });
    }
    const matchPath = `${GAMES_PREFIX}/${encodeURIComponent(guest.game)}/m/${encodeURIComponent(guest.matchId)}`;
    if (hasSessionCookie(request)) return reply.redirect(matchPath, 302);
    reply.setCookie(GUEST_COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      path: "/",
      expires: new Date(guest.expiresAt)
    });
    noteGuestOpened(guest.inviteId, request.ip);
    logGuestInviteEvent("opened", { id: guest.inviteId, guestName: guest.guestName, game: guest.game }, null, request.ip);
    return reply.redirect(matchPath, 302);
  });

  if (status.enabled) {
    await registerGamesGateway(app, { upstream, secret, available });
    app.log.info(`Games: proxying /games to ${upstream}`);
  }
}
