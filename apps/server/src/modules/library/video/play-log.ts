// What the gateway writes to this app's own log about Video: a film or an episode
// started (`library.video.played`), the one line Overview › Activity counts as
// "Watched" beside an audiobook played and an ebook read. The engine keeps where
// each person is in each title; this is the household's record that it happened.
//
// The player asks the engine's play call each time it starts a title — again on
// a reload, a seek past what is ready or a change of sound track — so one person
// starting one title counts once per few hours, not once per click.
import type { FastifyRequest } from "fastify";
import { logActivityOnce } from "../../../db.js";

const PLAYED_EVERY_MINUTES = 6 * 60;

/** Called as each request through the /video gateway finishes. */
export function notePlayResponse(prefix: string, request: FastifyRequest, statusCode: number): void {
  const user = request.user;
  if (!user || request.method !== "GET" || statusCode < 200 || statusCode >= 300) return;
  const path = request.url.split("?")[0];
  if (!path.startsWith(`${prefix}/api/play/`)) return;
  const itemId = decodeURIComponent(path.slice(`${prefix}/api/play/`.length));
  if (!itemId || itemId.includes("/")) return;
  logActivityOnce({
    event: "library.video.played",
    actorUserId: user.id,
    targetType: "video_item",
    targetId: itemId,
    detail: `${user.display_name} started watching ${itemId}.`,
    ipAddress: request.ip
  }, PLAYED_EVERY_MINUTES);
}
