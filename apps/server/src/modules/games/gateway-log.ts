// What the gateway writes to this app's own log (Control panel → Logs) about the
// games: who opened them, the match decisions that went through, and — the reason
// this exists — when the games container refused us or did not answer. Without it
// a mismatched GAMES_GATEWAY_SECRET left members on "Not signed in" while this
// app's log stayed empty: home had signed them in and forwarded the request fine,
// and only the games container's log said why. Moves and polling are left out on
// purpose (dozens a minute); the games container's own events cover the play.
import type { FastifyRequest } from "fastify";
import { logActivity } from "../../db.js";
import { GAMES_PREFIX } from "./gateway.js";

/** One "opened the games" line per person per half hour, not one per tab. */
const OPENED_EVERY_MS = 30 * 60_000;
/** A broken link repeats on every poll (each open tab, every few seconds), so the
 *  log and the warning say it once every ten minutes while it lasts. */
const TROUBLE_EVERY_MS = 10 * 60_000;

const lastOpened = new Map<string, number>();
const lastTrouble = new Map<"refused" | "unreachable", number>();

/** Throttle state is per process; tests start each case from a clean slate. */
export function resetGatewayLog(): void {
  lastOpened.clear();
  lastTrouble.clear();
}

function due(map: Map<string, number>, key: string, everyMs: number, now: number): boolean {
  const last = map.get(key);
  if (last !== undefined && now - last < everyMs) return false;
  map.set(key, now);
  return true;
}

const MATCH_ACTIONS: Record<string, { event: string; what: string }> = {
  accept: { event: "games.match_accepted", what: "accepted the invitation to match" },
  decline: { event: "games.match_declined", what: "declined the invitation to match" },
  cancel: { event: "games.match_withdrawn", what: "withdrew the invitation to match" },
  resign: { event: "games.match_resigned", what: "resigned match" }
};

/** The game a page address names: /games/dots/m/abc → "dots"; the lobby → null. */
function gameOfPage(path: string): string | null {
  const first = path.slice(GAMES_PREFIX.length).split("/").filter(Boolean)[0];
  return first && !first.includes(".") && first !== "static" && first !== "assets" ? decodeURIComponent(first) : null;
}

/** Called as each proxied request finishes, with the status the browser got. */
export function noteGatewayResponse(request: FastifyRequest, statusCode: number, now = Date.now()): void {
  const user = request.user;
  const guest = request.gamesGuest;
  // Nobody we let through (this app's own 401, a dead guest link): not ours to note.
  if (!user && !guest) return;
  const actorUserId = user?.id ?? null;
  const who = user ? user.display_name : `Guest ${guest!.guestName}`;
  const path = request.url.split("?")[0];
  const ip = request.ip;

  // We signed the request and the games server still said "not signed in": the
  // two containers' secrets differ (or the games one has none).
  if (statusCode === 401) {
    if (!due(lastTrouble, "refused", TROUBLE_EVERY_MS, now)) return;
    const detail = `The games server refused ${who}'s request (${request.method} ${path}) although this app had signed them in. GAMES_GATEWAY_SECRET here and GATEWAY_SECRET on the games container must be the same value; both containers read it when they start.`;
    request.log.warn({ path }, "Games server refused a signed request: the gateway secrets differ");
    logActivity({ event: "games.refused", actorUserId, targetType: "games", targetId: null, detail, ipAddress: ip });
    return;
  }
  // A container that is down comes back as the proxy's 500 (ECONNREFUSED) or a
  // 502–504; the games server's own failures are 500s too. Either way: say so.
  if (statusCode >= 500) {
    if (!due(lastTrouble, "unreachable", TROUBLE_EVERY_MS, now)) return;
    const detail = `The games server did not answer ${who}'s request, or failed it (${request.method} ${path}, ${statusCode}). Check that the games container is running and reachable at GAMES_URL; its own log says more.`;
    request.log.warn({ path, statusCode }, "Games server did not answer or failed the request");
    logActivity({ event: "games.unreachable", actorUserId, targetType: "games", targetId: null, detail, ipAddress: ip });
    return;
  }
  if (statusCode < 200 || statusCode >= 300) return;

  if (request.method === "GET" && (request.headers.accept ?? "").includes("text/html") && !path.startsWith(`${GAMES_PREFIX}/api/`)) {
    const key = user ? `user:${user.id}` : `guest:${guest!.inviteId}`;
    if (!due(lastOpened, key, OPENED_EVERY_MS, now)) return;
    const game = gameOfPage(path);
    logActivity({
      event: "games.opened",
      actorUserId,
      targetType: "games",
      targetId: game,
      detail: game ? `${who} opened ${game} in the games.` : `${who} opened the games.`,
      ipAddress: ip
    });
    return;
  }

  if (request.method !== "POST") return;
  if (path === `${GAMES_PREFIX}/api/matches`) {
    logActivity({ event: "games.match_started", actorUserId, targetType: "games_match", targetId: null, detail: `${who} started a match.`, ipAddress: ip });
    return;
  }
  const action = path.match(/^\/games\/api\/matches\/([^/]+)\/([a-z]+)$/);
  const known = action ? MATCH_ACTIONS[action[2]] : undefined;
  if (action && known) {
    const matchId = decodeURIComponent(action[1]);
    logActivity({ event: known.event, actorUserId, targetType: "games_match", targetId: matchId, detail: `${who} ${known.what} ${matchId}.`, ipAddress: ip });
  }
}
