import type { FastifyInstance, FastifyRequest } from "fastify";
import { nanoid, customAlphabet } from "nanoid";
import { z } from "zod";
import { db, logActivity, type User } from "../db.js";
import { sha256 } from "../crypto.js";
import { parseBody } from "./shared.js";

// Personal access tokens authenticate non-cookie clients (today: OPDS readers).
// Mirrors the hashing used for sessions/share links: only sha256(token) is
// persisted; the raw value is shown to the user exactly once at creation.
//
// Token shape: "isp_<scope>_<32 base62 chars>" (~190 bits of entropy). The prefix
// is identifiable in logs / secret scanners and lets resolve() reject obvious
// non-tokens before hashing.
const TOKEN_PREFIX = "isp_";
const tokenBody = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 32);

export type ApiTokenScope = "opds";

export interface ApiTokenRow {
  id: string;
  label: string | null;
  scope: string;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  expires_at: string | null;
}

export function generateApiToken(scope: ApiTokenScope = "opds"): { raw: string; hash: string } {
  const raw = `${TOKEN_PREFIX}${scope}_${tokenBody()}`;
  return { raw, hash: sha256(raw) };
}

// Mint a token for a user. Returns the row id and the RAW token (caller surfaces
// it once, then it's unrecoverable — only the hash is stored).
export function createApiToken(userId: string, label: string | null, scope: ApiTokenScope = "opds"): { id: string; raw: string } {
  const id = nanoid(16);
  const { raw, hash } = generateApiToken(scope);
  db.prepare(
    "INSERT INTO api_tokens (id, user_id, token_hash, scope, label) VALUES (?, ?, ?, ?, ?)"
  ).run(id, userId, hash, scope, label);
  return { id, raw };
}

// Resolve a raw token to its live user, or null when unknown / revoked / expired
// / for an inactive user. Bumps last_seen_at + last_ip on success. The single
// place token validity is enforced — every OPDS request goes through it.
export function resolveApiToken(raw: string, scope: ApiTokenScope = "opds", ip?: string | null): User | null {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = sha256(raw);
  const row = db.prepare(`
    SELECT users.*
    FROM api_tokens
    JOIN users ON users.id = api_tokens.user_id
    WHERE api_tokens.token_hash = ?
      AND api_tokens.scope = ?
      AND api_tokens.revoked_at IS NULL
      AND (api_tokens.expires_at IS NULL OR datetime(api_tokens.expires_at) > datetime('now'))
      AND users.deleted_at IS NULL
      AND users.is_active = 1
  `).get(hash, scope) as User | undefined;
  if (!row) return null;

  db.prepare(
    "UPDATE api_tokens SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_ip = ? WHERE token_hash = ?"
  ).run(ip ?? null, hash);
  return row;
}

// A user's active (non-revoked) tokens — never the secret.
export function listApiTokens(userId: string, scope?: ApiTokenScope): ApiTokenRow[] {
  const sql = `
    SELECT id, label, scope, created_at, last_seen_at, last_ip, expires_at
    FROM api_tokens
    WHERE user_id = ? AND revoked_at IS NULL ${scope ? "AND scope = ?" : ""}
    ORDER BY datetime(created_at) DESC
  `;
  return (scope ? db.prepare(sql).all(userId, scope) : db.prepare(sql).all(userId)) as ApiTokenRow[];
}

export function revokeApiToken(userId: string, id: string): boolean {
  const row = db.prepare("SELECT id FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL").get(id, userId);
  if (!row) return false;
  db.prepare("UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
  return true;
}

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.headers.host}`;
}

function serializeToken(row: ApiTokenRow) {
  return {
    id: row.id,
    label: row.label,
    scope: row.scope,
    createdAt: row.created_at,
    lastSeen: row.last_seen_at,
    lastIp: row.last_ip,
    expiresAt: row.expires_at
  };
}

const createTokenSchema = z.object({
  label: z.string().trim().max(60).optional()
});

// Self-service token management (cookie-authed). Each user manages only their own
// tokens; admins have no special view here — tokens are personal device keys.
export async function apiTokensPlugin(app: FastifyInstance) {
  app.get("/api/account/tokens", { preHandler: app.authenticate }, async (request) => {
    return { tokens: listApiTokens(request.user!.id, "opds").map(serializeToken) };
  });

  app.post("/api/account/tokens", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createTokenSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid token details", details: parsed.error });
      return;
    }

    const user = request.user!;
    const label = parsed.data.label?.length ? parsed.data.label : null;
    const { id, raw } = createApiToken(user.id, label, "opds");

    logActivity({
      event: "account.opds_token_created",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: `Created an OPDS reader token${label ? ` ("${label}")` : ""}.`,
      ipAddress: request.ip
    });

    // The catalog URL embeds the token in the path (one-paste, every client). The
    // same token also works as the Basic-auth password against the plain /opds URL.
    const origin = requestOrigin(request);
    reply.code(201).send({
      id,
      token: raw,
      catalogUrl: `${origin}/opds/${raw}`,
      basicUrl: `${origin}/opds`,
      username: user.email
    });
  });

  app.delete("/api/account/tokens/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!revokeApiToken(request.user!.id, id)) {
      reply.code(404).send({ error: "Token not found" });
      return;
    }
    logActivity({
      event: "account.opds_token_revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Revoked an OPDS reader token.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });
}
