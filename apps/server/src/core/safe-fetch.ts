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

export function isBlockedAddress(address: string): boolean {
  // Block loopback, link-local, and private ranges to prevent SSRF into the
  // local network or cloud metadata endpoints (e.g. 169.254.169.254).
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // URL brackets, zone id
  const kind = net.isIP(bare);
  if (kind === 4) {
    const [a, b] = bare.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // Not an address at all: nothing here can vouch for it, so it doesn't pass.
  if (kind !== 6) return true;

  // Judge IPv6 in ONE spelling. The URL parser gives the canonical form — lower
  // case, zeros compressed, an IPv4-mapped tail in hex (::ffff:7f00:1) however it
  // was written — so "0:0:0:0:0:0:0:1" and "::ffff:127.0.0.1" can't slip past a
  // prefix check written for "::1" and the dotted form.
  let v6: string;
  try {
    v6 = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  if (v6 === "::1" || v6 === "::") return true;
  const mapped = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isBlockedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = v6.startsWith("::") ? 0 : parseInt(v6.split(":")[0], 16);
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local (fe80–febf)
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (fc, fd)
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
  let chosen = records.find((record) => record.family === 4);
  if (!chosen && net.isIP(hostname) === 0) {
    // AAAA alone for a name is not always the whole answer: a resolver under a
    // burst (Docker's, on Unraid, while a map fetched tiles) can lose the A reply
    // and hand back what it has — and a pin to that fails with ENETUNREACH on a box
    // with no IPv6 route. Ask for IPv4 once more before settling for IPv6.
    const v4 = await dns.lookup(hostname, { all: true, family: 4 }).catch(() => []);
    for (const record of v4) {
      if (isBlockedAddress(record.address)) {
        throw new Error("URL resolves to a disallowed address.");
      }
    }
    chosen = v4.find((record) => record.family === 4);
  }
  chosen ??= records[0];
  return { address: chosen.address, family: chosen.family };
}

// A dispatcher that always connects to the pre-validated IP and never consults
// DNS again, so the address can't be rebound between check and use. undici still
// passes the original hostname to the socket for TLS SNI / cert validation and the
// Host header; only the connect target is overridden.
//
// The lookup answers on the next tick, never inside the call: Node's own lookup is
// always asynchronous, and a connect that fails at once (ENETUNREACH) inside a
// synchronous answer destroys the socket before tls.connect has finished setting
// it up — "Cannot read properties of null (reading 'setServername')".
function pinnedDispatcher(address: string, family: number, connections?: number): Agent {
  const lookup: net.LookupFunction = (_hostname, options, callback) => {
    process.nextTick(() => {
      if (options.all) {
        callback(null, [{ address, family }]);
      } else {
        callback(null, address, family);
      }
    });
  };
  return new Agent({ connect: { lookup }, ...(connections ? { connections } : {}) });
}

interface PinnedHost {
  dispatcher: Agent;
  expiresAt: number;
}

/** How long a retired dispatcher is kept open for requests that picked it up just
 *  before it was retired. */
const RETIRE_GRACE_MS = 60_000;

/**
 * Pinned connections that outlive one fetch, for a caller that asks the same host
 * many times in a burst — a map fetching tiles asks for a hundred at once.
 *
 * Without one, every fetch is its own DNS lookup (on libuv's threadpool, four
 * threads shared with every async file read in the server), its own TCP connect
 * and its own TLS handshake. A burst of those against a slow resolver filled the
 * threadpool, and the whole server waited behind it.
 *
 * The rebinding defence is unchanged: a host is resolved and checked, and its
 * connections go to that address and no other. The check is simply remembered for
 * `addressTtlMs` rather than repeated per request, and a network failure forgets
 * it so the next request asks DNS again.
 */
export class SafeFetchSession {
  private readonly hosts = new Map<string, Promise<PinnedHost>>();

  constructor(private readonly options: { connections: number; addressTtlMs: number }) {}

  private pin(hostname: string): Promise<PinnedHost> {
    const existing = this.hosts.get(hostname);
    if (existing) return existing;
    const created = resolveSafeAddress(hostname).then(({ address, family }) => ({
      dispatcher: pinnedDispatcher(address, family, this.options.connections),
      expiresAt: Date.now() + this.options.addressTtlMs
    }));
    this.hosts.set(hostname, created);
    // A failed lookup is not remembered: the next request asks again.
    created.catch(() => {
      if (this.hosts.get(hostname) === created) this.hosts.delete(hostname);
    });
    return created;
  }

  /** @internal fetchSafely's: the dispatcher for a host, re-checked once expired. */
  async dispatcherFor(hostname: string): Promise<Agent> {
    const entry = this.pin(hostname);
    const pinned = await entry;
    if (pinned.expiresAt > Date.now()) return pinned.dispatcher;
    if (this.hosts.get(hostname) === entry) this.retire(hostname, entry);
    return (await this.pin(hostname)).dispatcher;
  }

  /** @internal fetchSafely's: a request to this host failed on the network. */
  forget(hostname: string): void {
    const entry = this.hosts.get(hostname);
    if (entry) this.retire(hostname, entry);
  }

  private retire(hostname: string, entry: Promise<PinnedHost>): void {
    this.hosts.delete(hostname);
    void entry.then((pinned) => {
      setTimeout(() => void pinned.dispatcher.close().catch(() => {}), RETIRE_GRACE_MS).unref();
    }, () => {});
  }

  /** Close every connection now. */
  async close(): Promise<void> {
    const entries = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(entries.map((entry) => entry.then((pinned) => pinned.dispatcher.close(), () => {}).catch(() => {})));
  }
}

// Shared redirect loop: validate + pin each hop, fetch it with redirects handled
// manually, and hand the final (non-redirect) response to `consume`, which must
// fully read the body before returning — the pinned dispatcher is torn down as
// soon as `consume` resolves. With a `session`, the hop's dispatcher is the
// session's and stays open for the next request instead.
export async function fetchSafely<T>(
  url: string,
  options: { accept?: string; timeoutMs: number; failureMessage: string; session?: SafeFetchSession },
  consume: (response: Response) => Promise<T>
): Promise<T> {
  let current = new URL(url);
  const { session } = options;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("Only http(s) URLs are supported.");
    }

    // An IPv6 literal's hostname keeps its URL brackets ("[::1]"); unwrapped, the
    // lookup answers with the address itself on every platform, so a literal is
    // judged by isBlockedAddress rather than by whether getaddrinfo takes brackets.
    const hostname = current.hostname.replace(/^\[|\]$/g, "");
    let dispatcher: Agent;
    if (session) {
      dispatcher = await session.dispatcherFor(hostname);
    } else {
      const pin = await resolveSafeAddress(hostname);
      dispatcher = pinnedDispatcher(pin.address, pin.family);
    }

    try {
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          headers: {
            "user-agent": REMOTE_FETCH_USER_AGENT,
            ...(options.accept ? { accept: options.accept } : {})
          },
          signal: AbortSignal.timeout(options.timeoutMs),
          dispatcher
        });
      } catch (err) {
        // The address may be what failed: the next request resolves again.
        session?.forget(hostname);
        throw err;
      }

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
      if (!session) await dispatcher.close().catch(() => {});
    }
  }

  throw new Error(options.failureMessage);
}

