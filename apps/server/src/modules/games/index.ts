// Games — the way into isputnik.games, a project and container of its own that
// uses this server for sign-in (docs/games-platform-plan.md). A product module:
// it knows there are games and where they live. The gateway itself is gateway.ts.
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { registerGamesGateway } from "./gateway.js";

export function gamesConfigured(): { enabled: boolean; reason?: string } {
  if (!config.gamesUrl) return { enabled: false };
  if (!config.gamesGatewaySecret) return { enabled: false, reason: "GAMES_URL is set but GAMES_GATEWAY_SECRET is not; the games stay off until both are set." };
  if (!/^https?:\/\//.test(config.gamesUrl)) return { enabled: false, reason: `GAMES_URL must start with http:// or https:// (got "${config.gamesUrl}"); the games stay off.` };
  return { enabled: true };
}

export async function gamesPlugin(app: FastifyInstance) {
  const status = gamesConfigured();
  if (status.reason) app.log.warn(status.reason);

  // The web app asks this once to decide whether to show the Games entry.
  app.get("/api/games/status", { preHandler: app.authenticate }, async () => ({ enabled: status.enabled }));

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

  if (status.enabled) {
    await registerGamesGateway(app, { upstream: config.gamesUrl, secret: config.gamesGatewaySecret });
    app.log.info(`Games: proxying /games to ${config.gamesUrl}`);
  }
}
