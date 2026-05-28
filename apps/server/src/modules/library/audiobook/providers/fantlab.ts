import type { MetadataCandidate, MetadataSearchInput } from "./types.js";

const fantlabBaseUrl = "https://fantlab.ru";

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

function stripTags(value: string) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function matchFirst(value: string, pattern: RegExp) {
  return value.match(pattern)?.[1]?.trim();
}

function normaliseFantlabUrl(value?: string) {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("https:/images/")) {
    return `${fantlabBaseUrl}${value.slice("https:".length)}`;
  }
  if (value.startsWith("https:/img/logo")) {
    return undefined;
  }
  if (value.startsWith("https:/img/")) {
    return `${fantlabBaseUrl}${value.slice("https:".length)}`;
  }
  if (value.startsWith("https://") || value.startsWith("http://")) {
    return value;
  }
  if (value.startsWith("/")) {
    return `${fantlabBaseUrl}${value}`;
  }
  return `${fantlabBaseUrl}/${value}`;
}

function yearFromPlus(value?: string) {
  const match = value?.match(/\b(\d{4})\b/);
  return match ? Number(match[1]) : undefined;
}

function genreFromPlus(value?: string) {
  const genre = value?.split(",").slice(1).join(",").trim();
  return genre ? [genre] : undefined;
}

async function fetchFantlabHtml(url: string) {
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html",
      "User-Agent": "isputnik.home metadata lookup"
    }
  });
  if (!response.ok) {
    throw new Error("FantLab search failed.");
  }

  return response.text();
}

async function enrichFromWorkPage(relativeUrl: string) {
  try {
    const html = await fetchFantlabHtml(normaliseFantlabUrl(relativeUrl)!);
    const description = decodeHtml(matchFirst(html, /<meta\s+property="og:description"\s+content="([^"]*)"/i) ?? "");
    const coverUrl = normaliseFantlabUrl(matchFirst(html, /<meta\s+property="og:image"\s+content="([^"]*)"/i));

    // Original (non-Russian) title — shown on translated work pages
    const rawOriginal =
      matchFirst(html, /class="[^"]*altname[^"]*"[^>]*>([\s\S]*?)<\//i) ??
      matchFirst(html, /class="[^"]*original-name[^"]*"[^>]*>([\s\S]*?)<\//i) ??
      matchFirst(html, /Другие\s+названия[\s\S]*?<[^>]+>([\s\S]*?)<\//i);
    const originalTitle = rawOriginal ? stripTags(rawOriginal).trim() || undefined : undefined;

    return { description: description || undefined, coverUrl, originalTitle };
  } catch {
    return { description: undefined, coverUrl: undefined, originalTitle: undefined };
  }
}

export async function searchFantlab(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const params = new URLSearchParams({ searchstr: [input.query, input.author].filter(Boolean).join(" ") });
  const html = await fetchFantlabHtml(`${fantlabBaseUrl}/searchmain?${params}`);
  const worksSection = html.match(/<div class="search-block works">([\s\S]*?)(?:<div class="search-block|\<\/div>\s*<\/div>\s*<\/main>)/i)?.[1] ?? html;
  const blocks = Array.from(worksSection.matchAll(/<div class="one">([\s\S]*?)<div class="one-line">/gi))
    .slice(0, input.limit ?? 8);

  const candidates = await Promise.all(blocks.map(async (block) => {
    const chunk = block[1];
    const relativeUrl = matchFirst(chunk, /<div class="title">[\s\S]*?<a\s+href="([^"]+)"/i);
    const rawTitle = matchFirst(chunk, /<div class="title">[\s\S]*?<a\s+href="[^"]+"\s*[^>]*>([\s\S]*?)<\/a>/i);
    const author = matchFirst(chunk, /<div class="autor">[\s\S]*?<a\s+href="[^"]+"\s*[^>]*>([\s\S]*?)<\/a>/i);
    const plus = stripTags(matchFirst(chunk, /<div class="plus">([\s\S]*?)<\/div>/i) ?? "");
    const detail: { description?: string; coverUrl?: string } = relativeUrl ? await enrichFromWorkPage(relativeUrl) : {};

    return {
      title: stripTags(rawTitle ?? ""),
      subtitle: detail.originalTitle,
      authors: author ? [stripTags(author)] : [],
      year: yearFromPlus(plus),
      description: detail.description || undefined,
      coverUrl: detail.coverUrl,
      genres: genreFromPlus(plus),
      language: "ru",
      source: "fantlab" as const
    };
  }));

  return candidates.filter((candidate) => candidate.title);
}
