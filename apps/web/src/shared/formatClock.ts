// A length of time the way a player's clock shows it: "4:05", and "1:02:05" once
// it passes an hour. Not to be confused with `formatDuration` in shared/utils.ts,
// which words it ("2 hr 5 min").
//
// Seconds are floored, like a running clock. `round` rounds to the nearest second
// instead — for a stated media length, where 4.6 s is "0:05". `hours: false` keeps
// counting minutes past the hour ("75:03"), which is how the gallery has always
// labelled a video. Nothing (null/undefined) formats as "", and a value that isn't
// a real length (NaN, Infinity, negative) as "0:00".
/** The gallery's way of labelling a clip's length (and a video's running time). */
export const CLIP_LENGTH = { round: true, hours: false } as const;

export function formatClock(
  seconds: number | null | undefined,
  { round = false, hours = true }: { round?: boolean; hours?: boolean } = {}
): string {
  if (seconds == null) return "";
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = round ? Math.round(safe) : Math.floor(safe);
  const h = hours ? Math.floor(total / 3600) : 0;
  const m = Math.floor((total - h * 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
