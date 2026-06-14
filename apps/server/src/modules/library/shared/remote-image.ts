// SSRF-safe download of remote images (covers, author photos) from URLs that
// arrive via metadata providers. Every hop — including redirects, which
// archive.org and Open Library cover hosts rely on — is resolved and checked
// against private/internal address ranges before the request is made.
import dns from "node:dns/promises";

export const REMOTE_FETCH_USER_AGENT = "isputnik-home/1.0 (self-hosted family media library)";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export function isBlockedAddress(address: string) {
  // Block loopback, link-local, and private ranges to prevent SSRF into the
  // local network or cloud metadata endpoints (e.g. 169.254.169.254).
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("::ffff:")) return isBlockedAddress(normalized.slice(7));
  return false;
}

export async function* streamFromResponse(response: Response): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > 0) yield buffer;
    return;
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) yield value;
  }
}

async function assertSafeUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Unsupported image URL.");
  }
  const { address } = await dns.lookup(url.hostname);
  if (isBlockedAddress(address)) {
    throw new Error("Image URL resolves to a disallowed address.");
  }
}

export async function downloadImage(url: string, options: { maxBytes?: number; timeoutMs?: number } = {}) {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeUrl(current);

    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": REMOTE_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop === MAX_REDIRECTS) {
        throw new Error("Unable to download image.");
      }
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      throw new Error("Unable to download image.");
    }

    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > maxBytes) {
      throw new Error("Image is too large.");
    }

    // Enforce the cap while reading — Content-Length may be absent or untruthful.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of streamFromResponse(response)) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error("Image is too large.");
      }
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  throw new Error("Unable to download image.");
}

// SSRF-safe text/JSON fetch for user-supplied metadata links (Open Library /
// Apple / FantLab / LibriVox book pages). Same per-hop address guard and
// redirect handling as downloadImage; returns the decoded UTF-8 body, capped.
export async function fetchTextFromUrl(
  url: string,
  options: { accept?: string; maxBytes?: number; timeoutMs?: number } = {}
) {
  const maxBytes = options.maxBytes ?? MAX_TEXT_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeUrl(current);

    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": REMOTE_FETCH_USER_AGENT,
        ...(options.accept ? { accept: options.accept } : {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop === MAX_REDIRECTS) {
        throw new Error("Unable to fetch URL.");
      }
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}).`);
    }

    // Enforce the cap while reading — Content-Length may be absent or untruthful.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of streamFromResponse(response)) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error("Response is too large.");
      }
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  throw new Error("Unable to fetch URL.");
}
