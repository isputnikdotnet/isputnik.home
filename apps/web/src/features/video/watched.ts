import { useSyncExternalStore } from "react";
import { api } from "../../api";
import { videoDownloads } from "../../offline/video";
import { VIDEO_API, type VideoKind, type VideoProgress } from "./types";

// Marking a film, an episode or a part watched or not by hand (issue #101): seen
// somewhere else, or to be watched again. The engine keeps it with the place this
// person got to, per viewing profile, so Continue watching and what Play starts
// follow at once: a watched episode makes the one after it next, an unwatched one
// is next itself. A whole show, a season or a film with all its parts is one call
// (engine 0.32+; a title says so with `marksAll`).

/** Less than this in is a peek, not a place to come back to (the engine's RESUME_MIN_S). */
const RESUME_MIN_S = 30;

/** Left part-way: there is a place to resume from, and so one to reset. */
export function inProgress(progress: VideoProgress | null | undefined): boolean {
  return Boolean(progress && !progress.watched && progress.position >= RESUME_MIN_S);
}

/** Watched: at its end, nothing to resume. Not watched: back at the start. */
export async function markWatched(id: string, watched: boolean, duration: number | null): Promise<void> {
  const position = watched ? duration ?? 0 : 0;
  await api(`${VIDEO_API}/progress/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ position, duration, watched })
  });
  // A copy kept on this device remembers its own place: it follows, so the mark
  // holds with no connection too.
  await videoDownloads.store?.patch(id, { position, watched, positionAt: Date.now(), positionSynced: true }).catch(() => undefined);
  watchedChanged();
}

/** Every episode of a show (or of one season), or every part of a film: watched,
 *  or never seen — with nothing left to resume. */
export async function markAllWatched(kind: VideoKind, id: string, watched: boolean, season?: number): Promise<void> {
  await api(`${VIDEO_API}/watched/${kind}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ watched, ...(season === undefined ? {} : { season }) })
  });
  watchedChanged();
}

/** How long an item is, for a mark made without playing it: what the player
 *  measured last time, else its listed running time. */
export function knownDuration(progress: VideoProgress | null | undefined, runtimeMinutes?: number | null): number | null {
  return progress?.duration ?? (runtimeMinutes ? runtimeMinutes * 60 : null);
}

// A mark made on one card changes others on the page (the same film in another
// row, Continue watching): whatever lists watch state reads it again.
let stamp = 0;
const listeners = new Set<() => void>();

function watchedChanged(): void {
  stamp += 1;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Changes whenever something was marked by hand: an effect's reason to load again. */
export function useWatchedStamp(): number {
  return useSyncExternalStore(subscribe, () => stamp);
}
