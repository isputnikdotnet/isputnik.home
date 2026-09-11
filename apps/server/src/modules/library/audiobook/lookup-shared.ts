// What every online lookup shares — books and people alike: one polite queue so
// concurrent scans can't hammer the public APIs, the JSON fetch, and name/title
// matching.
import { REMOTE_FETCH_USER_AGENT } from "../shared/remote-image.js";
import type { MetadataCandidate } from "./providers/types.js";

const REQUEST_TIMEOUT_MS = 12_000;

// Pause between consecutive online lookups, shared across the whole process so
// concurrent scan workers can't hammer the public APIs.
const POLITENESS_DELAY_MS = 250;

let onlineQueue: Promise<unknown> = Promise.resolve();

export function enqueueLookup<T>(task: () => Promise<T>): Promise<T> {
  const run = onlineQueue.then(async () => {
    try {
      return await task();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, POLITENESS_DELAY_MS));
    }
  });
  onlineQueue = run.catch(() => {});
  return run;
}

export async function fetchJson<T>(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T | null> {
  const response = await fetch(url, {
    headers: { "user-agent": REMOTE_FETCH_USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    return null;
  }
  return await response.json() as T;
}

// ── Matching ─────────────────────────────────────────────────────────────────

export function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

// Folder titles often carry rip noise: "Pride and Prejudice (version 2) [64kbps]".
export function simplifyTitle(value: string) {
  return value
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleScore(local: string, candidate: string) {
  const a = normalizeText(local);
  const b = normalizeText(candidate);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 4) return 2;
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 && shared / union >= 0.6 ? 1 : 0;
}

// True when any name token of length ≥ 3 is shared — tolerates "Twain Mark"
// vs "Mark Twain" and initials-vs-full-name differences.
function authorsOverlap(localAuthors: string[], candidateAuthors: string[]) {
  const localTokens = new Set(
    localAuthors.flatMap((name) => normalizeText(name).split(" ")).filter((token) => token.length >= 3)
  );
  return candidateAuthors.some((name) =>
    normalizeText(name).split(" ").some((token) => token.length >= 3 && localTokens.has(token))
  );
}

export function pickCandidate(candidates: MetadataCandidate[], title: string, authors: string[]) {
  let best: { candidate: MetadataCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const score = Math.max(titleScore(title, candidate.title), titleScore(simplifyTitle(title), candidate.title));
    if (score === 0) continue;
    if (authors.length > 0 && candidate.authors.length > 0 && !authorsOverlap(authors, candidate.authors)) continue;
    // With no local author to verify against, demand a strong title match.
    if (authors.length === 0 && score < 2) continue;
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}
