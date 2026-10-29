// Stremio — a member's own add-on link into the video libraries they may see
// (docs/stremio-plan.md). Stremio cannot carry the session cookie, so the link
// carries a personal token in its path:
//
//   https://<home>/video/stremio/<token>/manifest.json
//
// The gateway (modules/apps/gateway.ts → userFromToken) resolves the token to its
// owner, who then goes through exactly the checks a session would — access to
// Video on Security › App access, the `devices` network rule, the libraries they
// may see — and the engine answers the add-on protocol from the signed headers.
// The engine never stores a token; it sees one only inside X-Isputnik-Base-Url,
// because Stremio fetches stream and art addresses as given.
//
// Every install is its own add-on: the engine names the add-on and its items
// after this server's id (core/server-id.ts), so a member of two servers can
// install both.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../../config.js";
import { logActivity, type User } from "../../../db.js";
import { createApiToken, isUnknownApiToken, listAllApiTokens, listApiTokens, resolveApiToken, revokeAnyApiToken, revokeApiToken, type ApiTokenRow } from "../../../core/api-tokens.js";
import { getServerId } from "../../../core/server-id.js";
import { flagAbusiveRequest } from "../../../core/security-alerts.js";
import { parseBody } from "../../../core/shared.js";

export const STREMIO_PREFIX = "/video/stremio";
const SCOPE = "video-stremio";

/** The token segment of a request under the Stremio prefix; null for any other path,
 *  "" for the prefix with no token. */
export function stremioTokenFromPath(url: string): string | null {
  const path = url.split("?")[0];
  if (path !== STREMIO_PREFIX && !path.startsWith(`${STREMIO_PREFIX}/`)) return null;
  return decodeURIComponent(path.slice(STREMIO_PREFIX.length + 1).split("/")[0] ?? "");
}

function appOrigin(): string {
  return config.appUrl.replace(/\/+$/, "");
}

/** What the add-on is called in Stremio: the install's own address tells two apart. */
export function stremioSiteName(): string {
  try {
    return `iSputnik · ${new URL(config.appUrl).host}`;
  } catch {
    return "iSputnik";
  }
}

/** The base every add-on address is built from — the operator's APP_URL, never the
 *  Host a client sent. */
export function stremioBaseUrl(raw: string): string {
  return `${appOrigin()}${STREMIO_PREFIX}/${raw}`;
}

export function stremioLinks(raw: string): { manifestUrl: string; installUrl: string } {
  const manifestUrl = `${stremioBaseUrl(raw)}/manifest.json`;
  // stremio:// opens the app's install dialog; Stremio reads it as https.
  return { manifestUrl, installUrl: manifestUrl.replace(/^https?:\/\//, "stremio://") };
}

/** The gateway's userFromToken hook for /video. */
export function stremioTokenUser(request: FastifyRequest, reply: FastifyReply): User | "answered" | null {
  const raw = stremioTokenFromPath(request.url);
  if (raw === null) return null;
  const user = raw ? resolveApiToken(raw, SCOPE, request.ip) : null;
  if (user) return user;
  // Only a token matching nothing at all counts as a guess; a revoked one is a TV
  // still holding a link its owner has since taken back.
  if (raw && isUnknownApiToken(raw)) flagAbusiveRequest(request, "token");
  void reply.code(401).send({ error: "This Stremio link is not valid any more." });
  return "answered";
}

/** What the engine needs on a token request beyond who is asking. */
export function stremioHeaders(request: FastifyRequest): Record<string, string> {
  const raw = stremioTokenFromPath(request.url);
  if (!raw) return {};
  return {
    "x-isputnik-site-id": getServerId(),
    "x-isputnik-site-name": encodeURIComponent(stremioSiteName()),
    "x-isputnik-base-url": stremioBaseUrl(raw)
  };
}

function serializeLink(row: ApiTokenRow) {
  return { id: row.id, label: row.label, createdAt: row.created_at, lastSeen: row.last_seen_at, lastIp: row.last_ip };
}

const createSchema = z.object({ label: z.string().trim().max(60).optional() });

/** Profile → Security › Stremio (the person's own links), and the administrator's
 *  list on Security › App access for revoking a lost device's link. */
export function registerStremioRoutes(app: FastifyInstance, enabled: (user: User) => boolean) {
  // Stremio is another origin. Home's own Cross-Origin-Resource-Policy
  // (same-origin) would have it refuse every poster, and home's CORS (its own
  // origin, with credentials) would have its player refuse every seek and
  // subtitle — an MP4 started, an MKV never did. The link's token is the
  // protection here, not the origin, and no cookie is needed.
  app.addHook("onSend", async (request, reply, payload) => {
    if (stremioTokenFromPath(request.url) === null) return payload;
    reply.header("cross-origin-resource-policy", "cross-origin");
    reply.header("access-control-allow-origin", "*");
    reply.removeHeader("access-control-allow-credentials");
    reply.removeHeader("set-cookie");
    return payload;
  });

  app.get("/api/account/stremio", { preHandler: app.authenticate }, async (request) => ({
    enabled: enabled(request.user!),
    links: listApiTokens(request.user!.id, SCOPE).map(serializeLink)
  }));

  app.post("/api/account/stremio", { preHandler: app.authenticate }, async (request, reply) => {
    if (!enabled(request.user!)) return reply.code(409).send({ error: "Video is not available on this server." });
    const parsed = parseBody(createSchema, request.body ?? {});
    if (parsed.error) return reply.code(400).send({ error: "Invalid link details", details: parsed.error });
    const user = request.user!;
    const label = parsed.data.label?.length ? parsed.data.label : null;
    const { id, raw } = createApiToken(user.id, label, SCOPE);
    logActivity({
      event: "account.stremio_link_created",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: `Created a Stremio link${label ? ` ("${label}")` : ""}.`,
      ipAddress: request.ip
    });
    return reply.code(201).send({ id, ...stremioLinks(raw) });
  });

  // untrustedAllow: taking a link back protects the account — never refused.
  app.delete("/api/account/stremio/:id", { preHandler: app.authenticate, config: { untrustedAllow: true } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!revokeApiToken(request.user!.id, id, SCOPE)) return reply.code(404).send({ error: "Link not found" });
    logActivity({
      event: "account.stremio_link_revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Revoked a Stremio link.",
      ipAddress: request.ip
    });
    return { ok: true };
  });

  app.get("/api/apps/admin/video/stremio-links", { preHandler: app.requireAdmin }, async () => ({
    links: listAllApiTokens(SCOPE).map((row) => ({ ...serializeLink(row), userId: row.user_id, userName: row.user_name }))
  }));

  app.delete("/api/apps/admin/video/stremio-links/:id", { preHandler: app.requireAdmin, config: { untrustedAllow: true } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const owner = revokeAnyApiToken(id, SCOPE);
    if (!owner) return reply.code(404).send({ error: "Link not found" });
    logActivity({
      event: "apps.stremio_link_revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: owner,
      detail: "Revoked a member's Stremio link.",
      ipAddress: request.ip
    });
    return { ok: true };
  });
}
