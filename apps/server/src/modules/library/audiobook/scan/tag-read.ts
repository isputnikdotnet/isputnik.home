// Reading an audio file's own tags: title, people, year, publisher, comment,
// embedded chapters — and repairing the mojibake legacy encodings leave in them.
import { parseFile, type IAudioMetadata } from "music-metadata";
import type { TagEncoding } from "../../shared/library-settings.js";
import { readMp4Chapters } from "../mp4-chapters.js";
import { splitNames } from "./folder-parse.js";
import type { PreparedChapter } from "./types.js";

/**
 * Repairs "mojibake" — text whose bytes are really in a legacy encoding (e.g. Windows-1251)
 * but were decoded as Latin-1, producing garble like "Ðàíåå" instead of "Ранее". We reverse the
 * bad decode (re-encode to Latin-1 bytes) and decode again with the correct charset.
 *
 * Strings that already contain characters above U+00FF were decoded correctly (e.g. real UTF-8
 * Cyrillic) and are left untouched. Plain ASCII passes through unchanged either way.
 */
export function repairEncoding(value: string | null | undefined, encoding: TagEncoding | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (!encoding) {
    return value;
  }
  // eslint-disable-next-line no-control-regex -- the range is the whole Latin-1 block, NUL included: anything outside it was decoded right
  if (/[^\u0000-\u00ff]/.test(value)) {
    return value;
  }
  try {
    const decoded = new TextDecoder(encoding).decode(Buffer.from(value, "latin1"));
    return decoded || value;
  } catch {
    return value;
  }
}

export function repairList(values: string[], encoding: TagEncoding | undefined): string[] {
  if (!encoding) {
    return values;
  }
  return values.map((value) => repairEncoding(value, encoding) ?? value);
}

export function stringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringValue).find((item): item is string => Boolean(item)) ?? null;
  }
  return null;
}

export function firstNativeString(metadata: IAudioMetadata | null, tagNames: string[]) {
  if (!metadata) {
    return null;
  }

  const wanted = new Set(tagNames.map((tag) => tag.toLowerCase()));
  for (const tags of Object.values(metadata.native)) {
    for (const tag of tags) {
      if (wanted.has(tag.id.toLowerCase())) {
        const value = stringValue(tag.value);
        if (value) {
          return value;
        }
      }
    }
  }

  return null;
}

// A name tagged as "Читает: Максим Пинскер", "Narrated by Jane Doe" or "Read by …"
// is the narrator whatever field it sits in. Rippers put it in album artist more
// often than not, where it would otherwise be catalogued as an author.
const NARRATOR_PREFIX_RE = /^\s*(?:читает|читают|чтец|чтецы|исполняет|исполнитель|narrated\s+by|narrator|narrators|read\s+by|reader)\s*[:\-–—]?\s*/i;

export interface TaggedPeople { authors: string[]; narrators: string[] }

// Authors and narrators from the artist-family tags. Album artist, artist and
// their list forms feed the authors unless a value carries a narrator prefix;
// composer is the conventional narrator field, except when it just repeats an
// author (some rippers put the writer there and the reader in album artist).
export function peopleFromTags(tags: {
  albumartists?: string[]; albumartist?: string; artists?: string[]; artist?: string; composer?: string[];
}): TaggedPeople {
  const authorValues: string[] = [];
  const narratorValues: string[] = [];
  for (const value of [...(tags.albumartists ?? []), tags.albumartist, ...(tags.artists ?? []), tags.artist]) {
    if (!value) continue;
    if (NARRATOR_PREFIX_RE.test(value)) narratorValues.push(value.replace(NARRATOR_PREFIX_RE, ""));
    else authorValues.push(value);
  }
  const authors = splitNames(authorValues);
  const authorKeys = new Set(authors.map((name) => name.toLowerCase()));
  const narrators = splitNames([
    ...narratorValues,
    ...(tags.composer ?? []).map((value) => value.replace(NARRATOR_PREFIX_RE, ""))
  ]).filter((name) => !authorKeys.has(name.toLowerCase()));
  return { authors, narrators };
}

export function splitTagValues(values: Array<string | string[] | null | undefined>) {
  return Array.from(new Set(values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .flatMap((value) => (value ?? "").split(/\s*(?:,|;)\s*/))
    .map((value) => value.trim())
    .filter(Boolean)));
}

export function firstComment(metadata: IAudioMetadata | null) {
  if (!metadata) {
    return null;
  }

  return metadata.common.longDescription
    ?? metadata.common.description?.find(Boolean)
    ?? metadata.common.comment?.map((comment) => comment.text?.trim()).find(Boolean)
    ?? null;
}

export function yearFromMetadata(metadata: IAudioMetadata | null) {
  if (!metadata) {
    return null;
  }

  const directYear = metadata.common.year ?? metadata.common.originalyear;
  if (directYear) {
    return directYear;
  }

  const date = metadata.common.date ?? metadata.common.originaldate ?? metadata.common.releasedate;
  const match = date?.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

export function numberFromTag(value: string | null) {
  if (!value) {
    return null;
  }

  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function primaryPublisher(metadata: IAudioMetadata | null) {
  return metadata?.common.publisher?.find(Boolean)
    ?? metadata?.common.label?.find(Boolean)
    ?? firstNativeString(metadata, ["tpub", "publisher"])
    ?? null;
}

export async function safeParseAudio(filePath: string, includeCover: boolean) {
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
    const parse = parseFile(filePath, {
      duration: true,
      skipCovers: !includeCover
    });
    return await Promise.race([parse, timeout]);
  } catch {
    return null;
  }
}

// Read embedded chapters from a single MP4 container (m4b/m4a). We parse the chapter
// track ourselves (see mp4-chapters.ts) rather than via music-metadata: its
// `includeChapters` pass can block the event loop for tens of seconds on some files
// (e.g. certain home-made m4b), which froze scans of larger libraries. The caller
// only invokes this for MP4 containers — MP3s are skipped entirely, since there each
// file already is a chapter.
export function extractChapters(filePath: string, encoding: TagEncoding | undefined): PreparedChapter[] {
  return readMp4Chapters(filePath)
    .map((chapter) => ({
      title: repairEncoding(chapter.title.trim() || null, encoding) ?? "",
      startSeconds: chapter.startSeconds,
      endSeconds: chapter.endSeconds
    }))
    .filter((chapter) => Number.isFinite(chapter.startSeconds))
    .sort((left, right) => left.startSeconds - right.startSeconds);
}
