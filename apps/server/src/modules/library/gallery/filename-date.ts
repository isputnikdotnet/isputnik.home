// Date-from-filename, the middle step of the gallery's "when was this taken?"
// chain: EXIF first, this second, the file's mtime last.
//
// It exists because mtime is a lie on any photo that has been copied, synced or
// restored — a 2012 photo through OneDrive or a NAS migration carries whatever
// timestamp the copy wrote. Meanwhile a huge share of metadata-stripped photos
// (phone exports, WhatsApp, Google Takeout, screenshots) carry the real date in
// the filename. When EXIF is silent, the name is much better evidence than the
// filesystem.
//
// The risk runs the other way — a false positive dates a photo confidently and
// wrongly — so the matching is deliberately strict: the digits must be delimited
// from any longer number, the calendar date has to actually exist (30 February
// is rejected, not clamped), and the year must be plausible. A time is used only
// when it is valid on its own; otherwise the date stands alone at midnight.

// Anchored to a real year so a random 8-digit id can't pass as a date.
const YEAR = "(19|20)\\d{2}";

// "2012-12-02T16-38-20", "2012_12_02 16.38.20", "2012-12-02" — a separated date,
// optionally followed by a separated time.
const DELIMITED = new RegExp(
  `(?<!\\d)(${YEAR})[-_.](\\d{2})[-_.](\\d{2})` +
  `(?:[T_ .-]+(\\d{2})[-:_.](\\d{2})[-:_.](\\d{2}))?(?!\\d)`
);

// "20121202_163820", "IMG_20121202_163820", "PXL_20121202_163820123",
// "IMG-20121202-WA0001" — the compact forms phones and exporters use. Sub-second
// digits after the time are consumed so they don't break the trailing boundary.
const COMPACT = new RegExp(
  `(?<!\\d)(${YEAR})(\\d{2})(\\d{2})` +
  `(?:[T_ .-]?(\\d{2})(\\d{2})(\\d{2})(?:\\d{1,3})?)?(?!\\d)`
);

function plausibleYear(year: number): boolean {
  // Photography predates 1900, but a filename claiming 1887 is far more likely to
  // be a serial number than a date. The upper bound allows for a clock skewed by
  // a timezone, not by years.
  return year >= 1900 && year <= new Date().getUTCFullYear() + 1;
}

// Real calendar date? Rebuilding and comparing rejects 2012-02-30 and 2012-13-01,
// which Date() would otherwise roll forward into March and January.
function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
}

function buildIso(
  year: number, month: number, day: number,
  hour: number | null, minute: number | null, second: number | null
): string | null {
  if (!plausibleYear(year) || !realDate(year, month, day)) return null;
  // A filename's time is a local wall-clock reading, like EXIF's DateTimeOriginal —
  // exifr hands those back as local Dates, so building one here keeps a filename
  // date and an EXIF date on the same footing.
  const usable = hour != null && minute != null && second != null
    && hour <= 23 && minute <= 59 && second <= 59;
  const date = usable
    ? new Date(year, month - 1, day, hour, minute, second)
    : new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fromMatch(match: RegExpMatchArray): string | null {
  // Group 2 is the year prefix inside YEAR — the capture numbering shifts past it.
  const [, year, , month, day, hour, minute, second] = match;
  return buildIso(
    Number(year), Number(month), Number(day),
    hour != null ? Number(hour) : null,
    minute != null ? Number(minute) : null,
    second != null ? Number(second) : null
  );
}

/**
 * The date encoded in a photo/video filename, as an ISO string, or null when the
 * name holds nothing that is confidently a date. Only the basename is read; the
 * extension is ignored.
 */
export function dateFromFileName(fileName: string): string | null {
  const base = fileName.replace(/\.[^.]+$/, "");
  if (!base) return null;
  // Delimited first: "2012-12-02" is unambiguous, while the compact pattern could
  // in principle latch onto a long number that happens to look like a date.
  for (const pattern of [DELIMITED, COMPACT]) {
    const match = base.match(pattern);
    if (match) {
      const iso = fromMatch(match);
      if (iso) return iso;
    }
  }
  return null;
}
