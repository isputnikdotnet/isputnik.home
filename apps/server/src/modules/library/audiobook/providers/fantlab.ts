import { MetadataLinkError, type MetadataCandidate, type MetadataSearchInput } from "./types.js";

// FantLab exposes a clean JSON API, which we use instead of scraping the HTML site
// (its markup shifts and had broken the old search parser). The API host serves the
// data; cover images come from the main site under /images/editions/…
const fantlabBaseUrl = "https://fantlab.ru";
const fantlabApiUrl = "https://api.fantlab.ru";

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Descriptions can carry inline HTML (e.g. <a> links inside an edition's blurb);
// flatten the markup to plain text.
function cleanText(value?: string | null) {
  if (!value) return undefined;
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) || undefined;
}

interface FantlabAuthor { name?: string }

interface FantlabSearchMatch {
  work_id?: number;
  rusname?: string;
  name?: string;
  all_autor_rusname?: string;
  year?: number;
  pic_edition_id?: number;
  pic_edition_id_auto?: number;
}

interface FantlabWork {
  work_name?: string;
  work_name_orig?: string;
  work_year?: number;
  work_description?: string;
  image?: string;
  lang_code?: string;
  authors?: FantlabAuthor[];
}

interface FantlabEdition {
  edition_name?: string;
  year?: number;
  description?: string;
  image?: string;
  lang_code?: string;
  isbns?: string[];
  creators?: { authors?: FantlabAuthor[] };
}

async function fetchFantlabJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "isputnik.home metadata lookup" }
  });
  if (response.status === 404) {
    throw new MetadataLinkError("That FantLab record was not found.");
  }
  if (!response.ok) {
    throw new Error("FantLab request failed.");
  }
  return response.json() as Promise<T>;
}

// The API gives an /images/editions/… path; fall back to building one from a
// search hit's representative edition id when no explicit image is present.
function coverUrl(image?: string | null, editionId?: number) {
  if (image) return image.startsWith("http") ? image : `${fantlabBaseUrl}${image}`;
  return editionId && editionId > 0 ? `${fantlabBaseUrl}/images/editions/big/${editionId}` : undefined;
}

function authorNames(authors?: FantlabAuthor[]) {
  return (authors ?? []).map((author) => decodeHtml(author.name ?? "").trim()).filter(Boolean);
}

// Filename-derived titles often carry a sequence prefix ("1. ", "01 - ", "3) ").
// The works API matches strictly and finds nothing for those, so drop a leading
// ordinal — but leave a bare year like "1984" (no separator) intact.
function cleanQuery(value: string) {
  return value.replace(/^\s*\d{1,3}\s*[.)\-]\s+/, "").trim();
}

// Search hits omit the blurb and original title; pull them from the work record.
async function enrichFromWork(workId?: number): Promise<{ description?: string; originalTitle?: string }> {
  if (!workId) return {};
  try {
    const work = await fetchFantlabJson<FantlabWork>(`${fantlabApiUrl}/work/${workId}`);
    return { description: cleanText(work.work_description), originalTitle: work.work_name_orig?.trim() || undefined };
  } catch {
    return {};
  }
}

export async function searchFantlab(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const query = [cleanQuery(input.query), input.author].filter(Boolean).join(" ").trim();
  if (!query) return [];
  const params = new URLSearchParams({ q: query, page: "1" });
  const data = await fetchFantlabJson<{ matches?: FantlabSearchMatch[] }>(`${fantlabApiUrl}/search-works?${params}`);
  const matches = (data.matches ?? []).slice(0, input.limit ?? 8);

  const candidates = await Promise.all(matches.map(async (match) => {
    const detail = await enrichFromWork(match.work_id);
    return {
      title: decodeHtml(match.rusname ?? match.name ?? "").trim(),
      subtitle: detail.originalTitle,
      authors: (match.all_autor_rusname ?? "").split(",").map((name) => name.trim()).filter(Boolean),
      year: match.year || undefined,
      description: detail.description,
      coverUrl: coverUrl(undefined, match.pic_edition_id_auto || match.pic_edition_id),
      language: "ru",
      source: "fantlab" as const
    };
  }));

  return candidates.filter((candidate) => candidate.title);
}

// Resolve a pasted FantLab link. Both works (/workNNNN — the abstract title) and
// editions (/editionNNNN — a specific published book) are supported; the API
// returns the same shape of fields from each.
export async function fetchFantlabByUrl(url: string): Promise<MetadataCandidate[]> {
  const pathname = new URL(url).pathname;

  const work = pathname.match(/^\/work(\d+)\/?$/);
  if (work) {
    const data = await fetchFantlabJson<FantlabWork>(`${fantlabApiUrl}/work/${work[1]}`);
    const title = decodeHtml(data.work_name ?? "").trim();
    if (!title) throw new MetadataLinkError("Could not read a title from that FantLab work.");
    return [{
      title,
      subtitle: data.work_name_orig?.trim() || undefined,
      authors: authorNames(data.authors),
      year: data.work_year || undefined,
      description: cleanText(data.work_description),
      coverUrl: coverUrl(data.image),
      language: data.lang_code || "ru",
      source: "fantlab"
    }];
  }

  const edition = pathname.match(/^\/edition(\d+)\/?$/);
  if (edition) {
    const data = await fetchFantlabJson<FantlabEdition>(`${fantlabApiUrl}/edition/${edition[1]}`);
    const title = decodeHtml(data.edition_name ?? "").trim();
    if (!title) throw new MetadataLinkError("Could not read a title from that FantLab edition.");
    return [{
      title,
      authors: authorNames(data.creators?.authors),
      year: data.year || undefined,
      description: cleanText(data.description),
      coverUrl: coverUrl(data.image),
      isbn: data.isbns?.[0]?.replace(/[^0-9Xx]/g, "") || undefined,
      language: data.lang_code || "ru",
      source: "fantlab"
    }];
  }

  throw new MetadataLinkError("That doesn't look like a FantLab link (expected fantlab.ru/workNNNN or /editionNNNN).");
}
