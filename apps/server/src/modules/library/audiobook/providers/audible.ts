// Audible catalogue provider. Audible has no official public API, but its
// app-facing catalogue endpoint (api.audible.com/1.0/catalog) is open and is the
// richest audiobook source — the only provider that reliably returns the
// narrator and the Audible ASIN, plus high-resolution cover art. Defaults to the
// US (.com) marketplace, which carries the broadest English catalogue.
import { REMOTE_FETCH_USER_AGENT } from "../../shared/remote-image.js";
import { MetadataLinkError, type MetadataCandidate, type MetadataSearchInput } from "./types.js";

const AUDIBLE_API = "https://api.audible.com/1.0/catalog/products";
const RESPONSE_GROUPS = "contributors,product_desc,product_attrs,media,series";
const IMAGE_SIZES = "500,1024";
const REQUEST_TIMEOUT_MS = 12_000;

interface AudibleProduct {
  asin?: string;
  title?: string;
  subtitle?: string;
  authors?: Array<{ name?: string }>;
  narrators?: Array<{ name?: string }>;
  publisher_name?: string;
  release_date?: string;
  publisher_summary?: string;
  merchandising_summary?: string;
  language?: string;
  product_images?: Record<string, string>;
}

interface AudibleListResponse { products?: AudibleProduct[]; }
interface AudibleItemResponse { product?: AudibleProduct; }

// Audible reports full language names; the rest of the app stores short codes.
const LANGUAGE_CODES: Record<string, string> = {
  english: "en", russian: "ru", german: "de", french: "fr", spanish: "es",
  italian: "it", dutch: "nl", portuguese: "pt", polish: "pl", japanese: "ja"
};

function languageCode(value?: string) {
  if (!value) return undefined;
  return LANGUAGE_CODES[value.trim().toLowerCase()] ?? value;
}

// Summaries arrive as HTML.
function stripHtml(value?: string) {
  if (!value) return undefined;
  const text = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}

function yearFromDate(value?: string) {
  const match = value?.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
}

function names(list?: Array<{ name?: string }>) {
  return (list ?? [])
    .map((entry) => entry.name?.trim())
    .filter((name): name is string => Boolean(name));
}

function toCandidate(product: AudibleProduct): MetadataCandidate | null {
  if (!product.title?.trim()) {
    return null;
  }
  const images = product.product_images ?? {};
  const coverUrl = images["1024"] ?? images["500"] ?? Object.values(images)[0];
  return {
    title: product.title.trim(),
    subtitle: product.subtitle?.trim() || undefined,
    authors: names(product.authors),
    narrators: names(product.narrators),
    publisher: product.publisher_name?.trim() || undefined,
    year: yearFromDate(product.release_date),
    description: stripHtml(product.publisher_summary ?? product.merchandising_summary),
    coverUrl: coverUrl || undefined,
    asin: product.asin,
    language: languageCode(product.language),
    source: "audible"
  };
}

async function audibleFetch<T>(pathAndQuery: string): Promise<T> {
  const response = await fetch(`${AUDIBLE_API}${pathAndQuery}`, {
    headers: { "user-agent": REMOTE_FETCH_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error("Audible search failed.");
  }
  return await response.json() as T;
}

export async function searchAudible(input: MetadataSearchInput): Promise<MetadataCandidate[]> {
  const params = new URLSearchParams({
    keywords: [input.query, input.author].filter(Boolean).join(" "),
    num_results: String(input.limit ?? 8),
    products_sort_by: "Relevance",
    response_groups: RESPONSE_GROUPS,
    image_sizes: IMAGE_SIZES
  });
  const payload = await audibleFetch<AudibleListResponse>(`?${params}`);
  return (payload.products ?? [])
    .map(toCandidate)
    .filter((candidate): candidate is MetadataCandidate => candidate !== null);
}

// Audible product links carry the 10-char ASIN as a path segment, e.g.
// https://www.audible.com/pd/The-Martian-Audiobook/B082BHJMFF — take the last
// segment that looks like an ASIN and fetch that product directly.
export async function fetchAudibleByUrl(url: string): Promise<MetadataCandidate[]> {
  const asin = new URL(url).pathname
    .split("/")
    .filter(Boolean)
    .reverse()
    .find((segment) => /^[A-Z0-9]{10}$/.test(segment));
  if (!asin) {
    throw new MetadataLinkError("Couldn't find an ASIN in that Audible link.");
  }
  const params = new URLSearchParams({ response_groups: RESPONSE_GROUPS, image_sizes: IMAGE_SIZES });
  const payload = await audibleFetch<AudibleItemResponse>(`/${asin}?${params}`);
  const candidate = payload.product ? toCandidate(payload.product) : null;
  return candidate ? [candidate] : [];
}
