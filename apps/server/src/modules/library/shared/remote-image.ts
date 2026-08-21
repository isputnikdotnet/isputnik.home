// Downloading remote images (covers, author photos) and text/JSON from URLs that
// arrive via metadata providers or are pasted by a user. The SSRF protection —
// per-hop address validation and IP pinning — lives in core/safe-fetch.ts; these
// are the two shapes the library needs, with their own size caps.
import {
  fetchSafely,
  streamFromResponse,
  FETCH_TIMEOUT_MS,
  REMOTE_FETCH_USER_AGENT,
  isBlockedAddress
} from "../../../core/safe-fetch.js";

// Re-exported for the callers that reach for them through this module.
export { REMOTE_FETCH_USER_AGENT, isBlockedAddress, streamFromResponse };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;

export async function downloadImage(url: string, options: { maxBytes?: number; timeoutMs?: number } = {}) {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  return fetchSafely(url, { timeoutMs, failureMessage: "Unable to download image." }, async (response) => {
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
  });
}

// SSRF-safe text/JSON fetch for user-supplied metadata links (Open Library /
// Apple / FantLab / LibriVox book pages). Same per-hop validation, IP pinning,
// and redirect handling as downloadImage; returns the decoded UTF-8 body, capped.
export async function fetchTextFromUrl(
  url: string,
  options: { accept?: string; maxBytes?: number; timeoutMs?: number } = {}
) {
  const maxBytes = options.maxBytes ?? MAX_TEXT_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  return fetchSafely(
    url,
    { accept: options.accept, timeoutMs, failureMessage: "Unable to fetch URL." },
    async (response) => {
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
  );
}
