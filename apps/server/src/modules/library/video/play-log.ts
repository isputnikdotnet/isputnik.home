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

// A title the BROWSER would not play: the engine served every segment, so its
// log has nothing, and the reason (the decoder's own words) exists only in the
// page. The player sends it here as it gives up, and it lands in this app's log
// for whoever went looking — once per person and title an hour, as a reload
// gives up the same way.
const FAILED_EVERY_MINUTES = 60;

export interface PlaybackFailure {
  itemId: string;
  /** What failed: the browser's media error or hls.js's, as it said it. */
  error: string;
  /** How the engine sent it: "direct", "remux" or "transcode". */
  mode?: string | null;
  /** Where in the title it gave up, in seconds. */
  at?: number | null;
}

export function notePlaybackFailed(request: FastifyRequest, failure: PlaybackFailure): void {
  const user = request.user;
  if (!user) return;
  const where = typeof failure.at === "number" && Number.isFinite(failure.at) ? ` at ${Math.round(failure.at)} s` : "";
  const how = failure.mode ? ` (${failure.mode})` : "";
  logActivityOnce({
    event: "library.video.playback_failed",
    actorUserId: user.id,
    targetType: "video_item",
    targetId: failure.itemId,
    detail: `${user.display_name}'s browser could not play ${failure.itemId}${how}${where}: ${failure.error}`,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"].slice(0, 300) : null
  }, FAILED_EVERY_MINUTES);
}
