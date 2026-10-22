// Games — the way into isputnik.games, a project and container of its own that
// uses this server for sign-in (docs/games-platform-plan.md). A product module:
// it knows there are games and where they live. The gateway itself is gateway.ts.
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { registerGamesGateway } from "./gateway.js";
import { getSections } from "../../core/sections.js";

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

export function gamesConfigured(): { enabled: boolean; reason?: string } {
  if (!config.gamesUrl) return { enabled: false };
  if (!config.gamesGatewaySecret) return { enabled: false, reason: "GAMES_URL is set but GAMES_GATEWAY_SECRET is not; the games stay off until both are set." };
  if (!/^https?:\/\//.test(config.gamesUrl)) return { enabled: false, reason: `GAMES_URL must start with http:// or https:// (got "${config.gamesUrl}"); the games stay off.` };
  return { enabled: true };
}

export async function gamesPlugin(app: FastifyInstance) {
  const status = gamesConfigured();
  if (status.reason) app.log.warn(status.reason);

  // The web app asks this once to decide whether to show the Games entry: the
  // gateway configured AND the admin's Games section on (core/sections.ts).
  app.get("/api/games/status", { preHandler: app.authenticate }, async () => ({ enabled: status.enabled && getSections().games }));

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
  app.get("/api/games/admin/status", { preHandler: app.requireAdmin }, async () => ({
    configured: status.enabled,
    reason: status.reason ?? null,
    url: config.gamesUrl || null,
    secretSet: Boolean(config.gamesGatewaySecret),
    server: status.enabled ? await probeGamesServer(config.gamesUrl) : null
  }));

  if (status.enabled) {
    await registerGamesGateway(app, {
      upstream: config.gamesUrl,
      secret: config.gamesGatewaySecret,
      // Switched off by the admin = not there: a bookmark gets a 404, not a game.
      available: () => getSections().games
    });
    app.log.info(`Games: proxying /games to ${config.gamesUrl}`);
  }
}
