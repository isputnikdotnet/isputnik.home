// Games — the way into isputnik.games, a project and container of its own that
// uses this server for sign-in (docs/games-platform-plan.md). A product module:
// it knows there are games and where they live. The gateway itself is gateway.ts.
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
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

  if (status.enabled) {
    await registerGamesGateway(app, { upstream: config.gamesUrl, secret: config.gamesGatewaySecret });
    app.log.info(`Games: proxying /games to ${config.gamesUrl}`);
  }
}
