// What a diagnostics report hides unless the admin asks to include it: the
// household's names and addresses. A report is made to be pasted into a public
// GitHub issue, so the default is that nobody reading it learns who lives there,
// where their files are or how to reach the server.
//
// Two layers. The names this server knows — every account's name and email, every
// library's name and folder, each container's library names and folders and the
// paths it reports — are replaced wherever they appear. Then patterns catch what
// no list can: email addresses, IP addresses (a LAN address stays recognisable as
// one), web addresses' hosts, and absolute paths under the usual roots (an ffmpeg
// error quotes the film's whole path).

export interface RedactionInput {
  /** People's names and emails. */
  people: string[];
  /** Library names, and anything else named by the household. */
  names: string[];
  /** Folders and files, absolute or relative to a media root. */
  paths: string[];
}

export type Redactor = (text: string) => string;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shorter than this, a name is too likely to be an ordinary word ("Al", "TV"). */
const MIN_NAME = 3;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Two groups and a double colon at least, or eight groups: not a clock (12:30:05). */
const IPV6 = /\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi;
const URL_HOST = /\b(https?:\/\/)(?:[^\s/"'<>@]+@)?[^\s/"'<>:]+(?::\d+)?/gi;
/** Where an absolute path begins: a drive, or a root a NAS, a container or a
 *  desktop keeps files under. What follows is worked out by pathEnd, since
 *  film names have spaces in them. */
const PATH_START = /(?:\b[A-Za-z]:[\\/]|(?<![\w.~<>-])\/(?:mnt|media|config|data|srv|home|Users|volume\d+|share|storage|downloads|tmp|var|opt|root)(?=[\\/]|\b))[^\n"'<>|,;]*/g;
/** A file name at the end of a path: up to its extension, spaces and all. */
const FILE_NAME = /^[^\\/:]*?\.[A-Za-z0-9]{1,5}(?=$|[\s:,;)\]])/;

/** Where a path that starts a candidate really ends: through its last folder,
 *  then its file name (to the extension) or else the next word. Hiding a word
 *  too many is the safe way to be wrong. */
function pathEnd(candidate: string): string {
  // ": " and " - " end a path whatever comes after.
  const stop = candidate.search(/: | - /);
  const text = stop === -1 ? candidate : candidate.slice(0, stop);
  const lastSeparator = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const head = text.slice(0, lastSeparator + 1);
  const tail = text.slice(lastSeparator + 1);
  const file = FILE_NAME.exec(tail)?.[0] ?? tail.split(/\s/)[0];
  return head + file;
}

function lanAddress(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

export function makeRedactor(input: RedactionInput): Redactor {
  // Longest first, so "Mum's films" goes before "Mum". As written: a folder's
  // case is its own, and "Movies" the library is not "movies" the word.
  const known = (values: { value: string; placeholder: string }[]) => values
    .map((entry) => ({ ...entry, value: entry.value.trim() }))
    .filter((entry) => entry.value.length >= MIN_NAME)
    .filter((entry, at, all) => all.findIndex((other) => other.value === entry.value) === at)
    .sort((a, b) => b.value.length - a.value.length)
    .map((entry) => ({ pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escape(entry.value)}(?![\\p{L}\\p{N}])`, "gu"), placeholder: entry.placeholder }));
  // A folder with a slash in it is a path, written with either slash; a bare
  // folder name ("Movies", relative to a media root) is only a name.
  const folders = input.paths.filter((value) => /[\\/]/.test(value));
  const bare = input.paths.filter((value) => !/[\\/]/.test(value));
  const pathRules = known(folders.flatMap((value) => [value, value.replace(/\//g, "\\"), value.replace(/\\/g, "/")]).map((value) => ({ value, placeholder: "<path>" })));
  const nameRules = known([
    ...input.people.map((value) => ({ value, placeholder: "<person>" })),
    ...[...input.names, ...bare].map((value) => ({ value, placeholder: "<name>" }))
  ]);
  return (text) => {
    // Known folders first, exactly as they are (spaces and all); then anything
    // else that looks like a path, so a name inside one doesn't cut it short;
    // then the names.
    let out = text;
    for (const rule of pathRules) out = out.replace(rule.pattern, rule.placeholder);
    out = out.replace(PATH_START, (candidate) => `<path>${candidate.slice(pathEnd(candidate).length)}`);
    for (const rule of nameRules) out = out.replace(rule.pattern, rule.placeholder);
    return out
      .replace(EMAIL, "<email>")
      .replace(URL_HOST, "$1<host>")
      // What goes on past a known folder is that folder's films and files: hidden too.
      // (A bare folder name with a slash after it is a path too.)
      .replace(/<(?:path|name)>([\\/][^\n"'<>|,;]*)/g, (_match, rest: string) => `<path>${rest.slice(pathEnd(rest).length)}`)
      // A known folder inside another: one placeholder.
      .replace(/<path>(?:[\\/]<path>)+/g, "<path>")
      .replace(IPV4, (ip) => (ip === "0.0.0.0" ? ip : lanAddress(ip) ? "<lan-ip>" : "<ip>"))
      .replace(IPV6, (ip) => (ip === "::1" ? ip : "<ip>"));
  };
}

/** Nothing hidden: the admin chose to include names and paths. */
export const keepEverything: Redactor = (text) => text;
