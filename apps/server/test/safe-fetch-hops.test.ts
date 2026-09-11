// What fetchSafely (core/safe-fetch.ts) does between the first request and the
// last: every redirect hop re-checked, every connection pinned to the address that
// was checked, the pinned dispatcher torn down after each hop, and the size and
// time caps remote-image.ts puts on what comes back.
//
// The pinning is the part with history. It exists to close DNS rebinding (a host
// answers public for the check, private for the connect); pinned to an AAAA record
// on an IPv4-only box it also crashed the process with ENETUNREACH, which is why a
// dual-stack host is pinned to its A record. And the dispatcher must be undici's
// own Agent handed to undici's own fetch — Node's bundled fetch rejects it.
//
// No network here: undici's fetch is replaced by a script of responses, its Agent
// by a recorder of what the dispatcher was built with, and DNS by a table. The
// real-socket half of this door is safe-fetch-address-policy.test.ts.
import dns from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const agents: { lookup: LookupFunction; close: ReturnType<typeof vi.fn> }[] = [];
  return { agents, fetch: vi.fn() };
});

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  class RecordingAgent {
    close = vi.fn(async () => {});
    constructor(options: { connect: { lookup: LookupFunction } }) {
      hoisted.agents.push({ lookup: options.connect.lookup, close: this.close });
    }
  }
  return { ...actual, Agent: RecordingAgent, fetch: hoisted.fetch };
});

import { fetchSafely, REMOTE_FETCH_USER_AGENT } from "../src/core/safe-fetch.js";
import { downloadImage, fetchTextFromUrl } from "../src/modules/library/shared/remote-image.js";

const PUBLIC_A = { address: "93.184.216.34", family: 4 };
const PUBLIC_B = { address: "198.51.100.20", family: 4 };
const PUBLIC_V6 = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

let dnsTable: Record<string, { address: string; family: number }[]>;
// The resolver as it was before the stub, for the literal addresses the table leaves alone.
let realLookup: typeof dns.lookup;

beforeEach(() => {
  hoisted.agents.length = 0;
  hoisted.fetch.mockReset();
  dnsTable = {
    "covers.example": [PUBLIC_A],
    "cdn.example": [PUBLIC_B],
    "internal.example": [{ address: "10.0.0.7", family: 4 }],
    "dual.example": [PUBLIC_V6, PUBLIC_A],
    "v6only.example": [PUBLIC_V6]
  };
  realLookup = dns.lookup.bind(dns) as typeof dns.lookup;
  vi.spyOn(dns, "lookup").mockImplementation((async (hostname: string) => {
    const records = dnsTable[hostname];
    if (!records) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return records;
  }) as unknown as typeof dns.lookup);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, headers: location ? { location } : {} });

/** The URLs fetch was actually asked for, in order. */
const fetchedUrls = () => hoisted.fetch.mock.calls.map(([url]) => String(url));

/** What a pinned dispatcher's socket would connect to, asked the two ways Node asks. */
function pinnedTarget(agentIndex: number, hostname = "whatever.example") {
  const { lookup } = hoisted.agents[agentIndex];
  let single: unknown;
  let all: unknown;
  lookup(hostname, {}, (_err, address, family) => { single = { address, family }; });
  lookup(hostname, { all: true }, (_err, addresses) => { all = addresses; });
  return { single, all };
}

describe("redirects", () => {
  it("follows a redirect to another public host, re-checking and re-pinning the hop", async () => {
    hoisted.fetch
      .mockResolvedValueOnce(redirect("https://cdn.example/real.jpg"))
      .mockResolvedValueOnce(new Response("JPEGDATA", { status: 200 }));

    const bytes = await downloadImage("https://covers.example/c.jpg");

    expect(bytes.toString()).toBe("JPEGDATA");
    expect(fetchedUrls()).toEqual(["https://covers.example/c.jpg", "https://cdn.example/real.jpg"]);
    expect(hoisted.agents).toHaveLength(2);
    expect(pinnedTarget(0).single).toEqual(PUBLIC_A);
    expect(pinnedTarget(1).single).toEqual(PUBLIC_B);
  });

  it("refuses a redirect to a host that resolves to a private address, without fetching it", async () => {
    hoisted.fetch.mockResolvedValueOnce(redirect("http://internal.example/admin"));

    await expect(downloadImage("https://covers.example/c.jpg")).rejects.toThrow(/disallowed address/);
    expect(fetchedUrls()).toEqual(["https://covers.example/c.jpg"]);
  });

  it.each([
    ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "the metadata endpoint"],
    ["http://127.0.0.1:4000/api/backups", "this server"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[::ffff:10.0.0.1]/", "IPv4-mapped private"],
    ["http://192.168.1.1/", "the router"]
  ])("refuses a redirect straight to %s (%s)", async (location) => {
    // Literal addresses go through the same lookup — the stub has no entry for
    // them, so hand them to the real resolver, which answers without the network.
    vi.mocked(dns.lookup).mockImplementation((async (hostname: string, options?: unknown) =>
      dnsTable[hostname] ?? realLookup(hostname, options as never)) as unknown as typeof dns.lookup);
    hoisted.fetch.mockResolvedValueOnce(redirect(location));

    await expect(fetchTextFromUrl("https://covers.example/book")).rejects.toThrow(/disallowed address/);
    expect(hoisted.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that leaves http(s)", async () => {
    hoisted.fetch.mockResolvedValueOnce(redirect("file:///etc/passwd"));

    await expect(downloadImage("https://covers.example/c.jpg")).rejects.toThrow(/Only http\(s\) URLs/);
    expect(hoisted.fetch).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative Location against the hop that sent it", async () => {
    hoisted.fetch
      .mockResolvedValueOnce(redirect("/images/big.jpg", 301))
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));

    await downloadImage("https://covers.example/c.jpg");

    expect(fetchedUrls()[1]).toBe("https://covers.example/images/big.jpg");
  });

  it("follows at most three redirects", async () => {
    hoisted.fetch
      .mockResolvedValueOnce(redirect("https://covers.example/1"))
      .mockResolvedValueOnce(redirect("https://covers.example/2"))
      .mockResolvedValueOnce(redirect("https://covers.example/3"))
      .mockResolvedValueOnce(new Response("third time lucky", { status: 200 }));
    await expect(fetchTextFromUrl("https://covers.example/0")).resolves.toBe("third time lucky");

    hoisted.fetch.mockReset();
    hoisted.fetch.mockImplementation(async () => redirect("https://covers.example/again"));
    await expect(fetchTextFromUrl("https://covers.example/0")).rejects.toThrow("Unable to fetch URL.");
    expect(hoisted.fetch).toHaveBeenCalledTimes(4); // the first request and three redirects
  });

  it("treats a redirect with no Location as a failure", async () => {
    hoisted.fetch.mockResolvedValueOnce(redirect(null));

    await expect(downloadImage("https://covers.example/c.jpg")).rejects.toThrow("Unable to download image.");
  });

  it("asks undici not to follow redirects itself, so no hop escapes the check", async () => {
    hoisted.fetch.mockResolvedValueOnce(new Response("x", { status: 200 }));

    await fetchTextFromUrl("https://covers.example/p", { accept: "application/json" });

    const init = hoisted.fetch.mock.calls[0][1] as { redirect: string; headers: Record<string, string>; dispatcher: unknown; signal: AbortSignal };
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({ "user-agent": REMOTE_FETCH_USER_AGENT, accept: "application/json" });
    expect(init.dispatcher).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the pinned connection", () => {
  it("connects to the address that was checked, whatever DNS says by then", async () => {
    // DNS rebinding: public for the check, private for the connect. The dispatcher's
    // lookup never asks DNS again, so the second answer is never heard.
    hoisted.fetch.mockImplementationOnce(async () => {
      dnsTable["covers.example"] = [{ address: "169.254.169.254", family: 4 }];
      return new Response("fine", { status: 200 });
    });

    await fetchTextFromUrl("https://covers.example/p");

    expect(pinnedTarget(0, "covers.example")).toEqual({ single: PUBLIC_A, all: [PUBLIC_A] });
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });

  it("pins a dual-stack host to its IPv4 address", async () => {
    // Pinned to the AAAA record, an IPv4-only install (a typical Unraid box) fails
    // the connect with ENETUNREACH — which once took the whole process down.
    hoisted.fetch.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await fetchTextFromUrl("https://dual.example/p");

    expect(pinnedTarget(0).single).toEqual(PUBLIC_A);
  });

  it("still reaches an IPv6-only host rather than skipping it", async () => {
    hoisted.fetch.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await fetchTextFromUrl("https://v6only.example/p");

    expect(pinnedTarget(0).single).toEqual(PUBLIC_V6);
  });

  it("closes every hop's dispatcher, on success and on failure", async () => {
    hoisted.fetch
      .mockResolvedValueOnce(redirect("https://cdn.example/x"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await downloadImage("https://covers.example/c.jpg");
    expect(hoisted.agents.map((agent) => agent.close.mock.calls.length)).toEqual([1, 1]);

    hoisted.agents.length = 0;
    hoisted.fetch.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(downloadImage("https://covers.example/c.jpg")).rejects.toThrow();
    expect(hoisted.agents.map((agent) => agent.close.mock.calls.length)).toEqual([1]);

    hoisted.agents.length = 0;
    hoisted.fetch.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(downloadImage("https://covers.example/c.jpg")).rejects.toThrow("socket hang up");
    expect(hoisted.agents.map((agent) => agent.close.mock.calls.length)).toEqual([1]);
  });
});

describe("limits on what comes back", () => {
  it("gives up when the server is too slow", async () => {
    // A fetch that never answers on its own: only the timeout's abort ends it.
    hoisted.fetch.mockImplementationOnce((_url: unknown, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      })
    );

    const started = Date.now();
    await expect(downloadImage("https://covers.example/slow.jpg", { timeoutMs: 50 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses an image whose declared size is over the cap, before reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024)); }
    });
    hoisted.fetch.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-length": String(50 * 1024 * 1024) } }));

    await expect(downloadImage("https://covers.example/huge.jpg")).rejects.toThrow("Image is too large.");
    expect(pulled).toBeLessThanOrEqual(1); // the stream's own first pull, at most
  });

  it("stops reading an image that lies about its size (or doesn't give one)", async () => {
    // An endless body: only the running count can stop this.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(4096)); }
    });
    hoisted.fetch.mockResolvedValueOnce(new Response(endless, { status: 200, headers: { "content-length": "100" } }));

    await expect(downloadImage("https://covers.example/liar.jpg", { maxBytes: 64 * 1024 })).rejects.toThrow("Image is too large.");
    expect(pulled).toBeLessThan(40);
  });

  it("keeps an image at exactly the cap", async () => {
    hoisted.fetch.mockResolvedValueOnce(new Response(new Uint8Array(2048), { status: 200 }));

    const bytes = await downloadImage("https://covers.example/exact.jpg", { maxBytes: 2048 });
    expect(bytes.byteLength).toBe(2048);
  });

  it("refuses an image the server says it doesn't have", async () => {
    hoisted.fetch.mockResolvedValueOnce(new Response("<html>not found</html>", { status: 404 }));

    await expect(downloadImage("https://covers.example/missing.jpg")).rejects.toThrow("Unable to download image.");
  });

  it("caps a text response too, and decodes UTF-8", async () => {
    hoisted.fetch.mockResolvedValueOnce(new Response("Мастер и Маргарита", { status: 200 }));
    await expect(fetchTextFromUrl("https://covers.example/book")).resolves.toBe("Мастер и Маргарита");

    hoisted.fetch.mockResolvedValueOnce(new Response("x".repeat(5000), { status: 200 }));
    await expect(fetchTextFromUrl("https://covers.example/book", { maxBytes: 1000 })).rejects.toThrow("Response is too large.");

    hoisted.fetch.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    await expect(fetchTextFromUrl("https://covers.example/book")).rejects.toThrow("Request failed (503).");
  });

  it("hands the final response to the consumer and nothing else", async () => {
    hoisted.fetch
      .mockResolvedValueOnce(redirect("https://cdn.example/final"))
      .mockResolvedValueOnce(new Response("{\"ok\":true}", { status: 200 }));
    const seen: number[] = [];

    const result = await fetchSafely(
      "https://covers.example/start",
      { timeoutMs: 1000, failureMessage: "nope" },
      async (response) => { seen.push(response.status); return response.json(); }
    );

    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([200]);
  });
});
