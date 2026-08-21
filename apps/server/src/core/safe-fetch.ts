// SSRF-safe outbound HTTP. Every hop — including redirects, which several
// metadata hosts rely on — is resolved and checked against private/internal
// address ranges, then the connection is *pinned* to the exact IP that was
// validated. Pinning closes the DNS rebinding (TOCTOU) window: without it, the
// check and the fetch each resolve DNS independently, so a host with a low-TTL
// record could answer with a public IP for the check and an internal one (e.g.
// 169.254.169.254) for the fetch. The original hostname is still used for TLS
// SNI, certificate validation, and the Host header.
//
// This lives in core because it is platform infrastructure with no product
// knowledge: cover art, metadata pages and the location database all reach the
// internet through this one door. It was extracted from library/shared/
// remote-image.ts, which now imports it like everyone else.
import dns from "node:dns/promises";
import net from "node:net";
// Use undici's own fetch (not Node's global fetch) so it pairs with the Agent we
// build below: a dispatcher from the standalone undici package is rejected by
// Node's *bundled* undici fetch ("invalid onRequestStart method") because the two
// copies can differ in version. Importing both from here keeps them in lockstep.
import { Agent, fetch, type Response } from "undici";

export const REMOTE_FETCH_USER_AGENT = "isputnik-home/1.0 (self-hosted family media library)";

export const FETCH_TIMEOUT_MS = 15_000;
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

// Resolve every A/AAAA record for the host and reject if ANY of them lands in a
// private/internal range — checking all records (not just the first) stops a host
// from pairing a public answer with a private one. Returns the address we will
// pin the connection to.
async function resolveSafeAddress(hostname: string): Promise<{ address: string; family: number }> {
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) {
    throw new Error("URL host could not be resolved.");
  }
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error("URL resolves to a disallowed address.");
    }
  }
  // Prefer an IPv4 record when the host is dual-stack. Because we pin the socket
  // to a single address (DNS-rebinding defence), we can't fall back mid-connect —
  // and many self-hosted deployments (e.g. an IPv4-only Unraid box) have no IPv6
  // route, so pinning to an AAAA record there fails the connect with ENETUNREACH
  // and, on a background socket, can crash the process. IPv4-first keeps those
  // hosts reachable; a genuinely IPv6-only host still resolves (and simply fails
  // to connect if unroutable, rather than being skipped).
  const chosen = records.find((record) => record.family === 4) ?? records[0];
  return { address: chosen.address, family: chosen.family };
}

// A single-use dispatcher that always connects to the pre-validated IP and never
// consults DNS again, so the address can't be rebound between check and use.
// undici still passes the original hostname to the socket for TLS SNI / cert
// validation and the Host header; only the connect target is overridden.
function pinnedDispatcher(address: string, family: number): Agent {
  const lookup: net.LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
  return new Agent({ connect: { lookup } });
}

// Shared redirect loop: validate + pin each hop, fetch it with redirects handled
// manually, and hand the final (non-redirect) response to `consume`, which must
// fully read the body before returning — the pinned dispatcher is torn down as
// soon as `consume` resolves.
export async function fetchSafely<T>(
  url: string,
  options: { accept?: string; timeoutMs: number; failureMessage: string },
  consume: (response: Response) => Promise<T>
): Promise<T> {
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("Only http(s) URLs are supported.");
    }

    const pin = await resolveSafeAddress(current.hostname);
    const dispatcher = pinnedDispatcher(pin.address, pin.family);

    try {
      const response = await fetch(current, {
        redirect: "manual",
        headers: {
          "user-agent": REMOTE_FETCH_USER_AGENT,
          ...(options.accept ? { accept: options.accept } : {})
        },
        signal: AbortSignal.timeout(options.timeoutMs),
        dispatcher
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location || hop === MAX_REDIRECTS) {
          throw new Error(options.failureMessage);
        }
        current = new URL(location, current);
        continue;
      }

      return await consume(response);
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }

  throw new Error(options.failureMessage);
}

