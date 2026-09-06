// The library-relative subfolder a photo is filed under by date: `YYYY/YYYY-MM-DD`
// from its capture date, so uploads and kept Inbox photos land in dated folders
// alongside the rest of the library instead of piling up at the root. Y/M/D come
// straight from the ISO prefix (no timezone shift); `fallback` (the upload time) is
// used when the photo carries no date. Pure + injectable for tests.
//
// Its own module because both the upload route and the Inbox's Keep need it, and
// the Inbox module must not import the routes file that registers it.
export function dateFolderForCapture(takenAt: string | null, fallback: Date): string {
  const parts = takenAt ? /^(\d{4})-(\d{2})-(\d{2})/.exec(takenAt) : null;
  const y = parts ? Number(parts[1]) : fallback.getFullYear();
  const m = parts ? Number(parts[2]) : fallback.getMonth() + 1;
  const d = parts ? Number(parts[3]) : fallback.getDate();
  return `${y}/${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
